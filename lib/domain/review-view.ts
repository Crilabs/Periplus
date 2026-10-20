import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Geometry, Point, Polygon } from "geojson";
import { z } from "zod";
import type { NominatimHit } from "@/lib/adapters/nominatim";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import {
  changeRateEnum,
  DOC_TYPES,
  geoNames,
  documents,
  geoObjects,
  nameCandidates,
  placeKindEnum,
  places,
  reviewKindEnum,
  reviewTasks,
  tiles,
  type GeoObjectType,
  type GeoOrigin,
  type NameOrigin,
  type NameCandidateStatus,
  type PlaceKind,
  type PlaceStatus,
  type PoiCategory,
  type ReviewKind,
  type ReviewStatus,
  type ChangeRate,
  type DocType,
  type RestrictedKind,
} from "@/lib/db/schema";
import type { AttributeProvenance, ConflictResolution, ConflictSide } from "@/lib/domain/consolidation/types";
import type { ProposalRobots, SerpHit } from "@/lib/domain/discovery/proposals";
import { formatReviewValue, profileAttributeLabel } from "@/lib/domain/consolidation/format";
import { comparisonTaskContextSchema } from "@/lib/domain/quality/comparison-results";
import type { ComparisonAttribute } from "@/lib/db/schema/quality";
import { canonicalJson } from "@/lib/domain/facts/schema";
import { factViewsByIds, geoFacts, type FactView } from "@/lib/domain/geo-facts";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { candidateObjects, withNeighbours } from "@/lib/domain/mentions/scope";
import {
  afterInQueue,
  nameCandidateRing,
  newNameObjectType,
  suggestedKindForHint,
  nextOpenTask,
  QUEUE_ORDER,
  sourceSettingsKey,
  valueFingerprint,
} from "@/lib/domain/review-decisions";
import { crawlRulesSchema, type CrawlRules } from "@/lib/domain/sources/crawl-rules";
import { getSource, type Source } from "@/lib/domain/sources/store";
import { latestProfile } from "@/lib/domain/timeline";
import { consolidationConfigFor } from "@/lib/domain/consolidation/active-rules";
import { droppedSafetyEntries } from "@/lib/domain/profile-view";

/** Places offered for "merge into a place". */
export const NEARBY_PLACES = 5;
/** Areas offered for a coast tile, nearest first. */
export const AREA_CHOICES = 20;
/** Objects of a name candidate's candidate space offered for "assign the name", nearest first. */
export const OBJECT_CHOICES = 30;

export type ReviewTaskRow = {
  id: string;
  kind: ReviewKind;
  subjectType: string;
  subjectId: string;
  /**
   * What the task is about, for the list (gesamt review UI-6): the context name (seed, bay or name candidate), else the
   * source's domain, the place's or object's name (two names for a pair), or the failed job's queue; null when none.
   */
  name: string | null;
  /** The attribute of a profile task (German label) or a comparison deviation (its key); null for other kinds. */
  attribute: string | null;
  /** A `comparison_deviation` on an evaluation candidate's value (context `evaluationRunId`), not on the regular profile. */
  evaluation: boolean;
  priority: number;
  createdAt: Date;
};

export type LonLat = { lon: number; lat: number };
export type NameView = { name: string; language: string; origin: NameOrigin };
export type GeoObjectView = {
  id: string;
  type: GeoObjectType;
  origin: GeoOrigin;
  osmId: string | null;
  wikidataId: string | null;
  geonamesId: string | null;
  geom: Geometry;
  names: NameView[];
};
export type NearbyPlace = {
  id: string;
  name: string | null;
  kind: PlaceKind;
  status: PlaceStatus;
  position: LonLat;
  distanceM: number;
};

/**
 * A restricted area a `place_candidate` review of a confirmed place is about (`context.reason = "restricted"`, GR-5 /
 * UI-4): kind, the dataset reference, the importing source and the share of the anchor area it covers.
 */
export type RestrictionView = {
  id: string;
  kind: RestrictedKind;
  sourceRef: string | null;
  sourceName: string | null;
  share: number | null;
};

export type ReviewSubject =
  | {
      type: "place";
      place: {
        id: string;
        kind: PlaceKind;
        status: PlaceStatus;
        publicId: string | null;
        tileId: string | null;
        position: LonLat;
      };
      geoObject: GeoObjectView;
      nearby: NearbyPlace[];
      /** „Bucht bei …“ of a bay detected from geometry (display only, no geo name); null otherwise. */
      helperName: string | null;
      /** The restricted areas of a restricted-area review (`context.reason = "restricted"`); null for another task. */
      restrictions: RestrictionView[] | null;
      /**
       * The object's facts so far, newest active fact per attribute with the number of facts (spec 09 „bisherige Facts,
       * Quelle mit Gewicht“, UI-13): computed shelter and depth, text facts with their source.
       */
      facts: Array<{ attribute: string; newest: FactView; count: number }>;
    }
  | {
      type: "geo_object_pair";
      objects: GeoObjectView[];
      distanceM: number | null;
      similarity: number | null;
    }
  | {
      type: "tile";
      tile: {
        id: string;
        bbox: Polygon;
        hasCoast: boolean;
        areaId: string | null;
      };
      areas: Array<{ id: string; name: string | null; distanceM: number }>;
    }
  | {
      type: "job";
      job: {
        id: string;
        queue: string | null;
        key: string | null;
        stage: string | null;
        error: string | null;
        runId: string | null;
        /** The source the job worked on (offers "pause source"). */
        sourceId: string | null;
      };
    }
  | {
      type: "source";
      source: Source;
      /** Best SERP hits by rank (empty for a link graph proposal). */
      hits: SerpHit[];
      /** All SERP hits of the domain; `hits` holds only the best of them. */
      hitCount: number;
      /** Approved sources linking to the domain. */
      linkingSources: number;
      languages: string[];
      /** robots.txt summary at proposal time; null when the task has none. */
      robots: ProposalRobots | null;
      /**
       * Approval form defaults: the source's current values. Discovery writes its suggestion into the row, so they only
       * differ from `originalSuggestion` after an edit on the source page, which the approval must not undo (UI-1).
       */
      suggestion: SourceSuggestion;
      /** The suggestion the proposal was made with (task context); null when the task has none. */
      originalSuggestion: SourceSuggestion | null;
      /** The source's values differ from `originalSuggestion` (edited on the source page). */
      editedSinceProposal: boolean;
      /** `sourceSettingsKey` of `suggestion`: the approval form posts it, so a stale form is refused (W4-1). */
      settingsKey: string;
    }
  | {
      type: "name_candidate";
      candidate: {
        id: string;
        name: string;
        hint: string | null;
        tileId: string;
        status: NameCandidateStatus;
        documents: number;
        sources: number;
      };
      /** Null when the tile row is missing. */
      tile: { id: string; bbox: Polygon } | null;
      /** The geo object "create place" makes for each place kind (from the hint, else the kind). */
      objectTypes: Record<PlaceKind, { type: GeoObjectType; category: PoiCategory | null }>;
      /** The kind the form starts with, from the name's hint (`suggestedKindForHint`). */
      suggestedKind: PlaceKind;
      hits: NominatimHit[];
      occurrences: NameOccurrenceView[];
      /** Valid objects of the candidate space (tile and neighbours), nearest to the tile centre first. */
      objects: Array<{ id: string; name: string | null; type: GeoObjectType; distanceM: number }>;
      /** Places nearest to the tile centre. */
      nearby: NearbyPlace[];
    }
  | ProfileAttributeSubject
  | {
      type: "profile_summary";
      geoObjectId: string;
      name: string | null;
      version: number;
      attempts: number | null;
      /** Why each attempt failed: `copied`, `sentences`, `invalid`. */
      reasons: string[];
    }
  | ComparisonSubjectView
  | { type: "missing" };

/**
 * A `comparison_deviation` task: the place, the compared attribute and the own value as compared (`ownDisplay`).
 * Nothing of Navily: the admin checks the Navily value in the Navily app (Grundprinzip 9).
 */
export type ComparisonSubjectView = {
  type: "comparison";
  place: {
    id: string;
    publicId: string | null;
    name: string | null;
    kind: PlaceKind;
    status: PlaceStatus;
    position: LonLat;
  };
  attribute: ComparisonAttribute;
  valueHash: string;
  /** Null for an evaluation profile. */
  profileVersion: number | null;
  evaluationRunId: string | null;
  ownDisplay: string | null;
};

/** One value of a conflict: its summed weight, when it was observed and the facts behind it. */
export type ProfileSideView = {
  value: unknown;
  /** `valueFingerprint` of `value`: what a decision for this side posts (ruling M5-G-R2). */
  fingerprint: string;
  display: string;
  weight: number;
  observedFrom: string;
  observedTo: string;
  /** Text, computed or review facts of the side that still exist (newest observation first). */
  facts: FactView[];
};

/**
 * A `conflict` / `uncertain_change` task on one attribute of a geo object's profile: the profile's current value with
 * its provenance, the two sides of a conflict (`a`, `b`, further value groups in `others`) or the proposed value of an
 * uncertain change (with the sides of the conflict note when a held safety value's weak values disagree, ruling
 * M6-FIN-R3), each with the facts behind it. `key` is the context key the decision must name (ruling M5-F-R2);
 * `resolution` is the resolution the current profile records for the conflict key (a decided conflict).
 */
export type ProfileAttributeSubject = {
  type: "profile_attribute";
  geoObjectId: string;
  /** The object's display name; null when it has none. */
  name: string | null;
  attribute: string;
  label: string;
  key: string | null;
  current: { value: unknown; display: string; provenance: AttributeProvenance | null };
  a?: ProfileSideView;
  b?: ProfileSideView;
  others?: ProfileSideView[];
  /**
   * `removes`: the entries „Übernehmen“ takes out of a safety list (`droppedSafetyEntries` of the context's old and
   * new value), one display each; empty for any other change (wave-1 review M-3).
   */
  proposed?: { value: unknown; display: string; facts: FactView[]; removes: string[] };
  resolution: ConflictResolution | null;
};

/** Where a new name stands in a text; `start`/`end` index into `snippet`. */
export type NameOccurrenceView = {
  documentId: string;
  versionId: string;
  chunkId: string;
  snippet: string;
  start: number;
  end: number;
  url: string | null;
};

export type SourceSuggestion = { type: DocType; weight: number; changeRate: ChangeRate; crawlRules: CrawlRules };

export type ReviewTaskDetail = {
  task: {
    id: string;
    kind: ReviewKind;
    status: ReviewStatus;
    subjectType: string;
    subjectId: string;
    priority: number;
    createdAt: Date;
  };
  subject: ReviewSubject;
};

/** Open review tasks per kind (every kind present, 0 when none). */
export async function reviewCounts(db: Db): Promise<Record<ReviewKind, number>> {
  const rows = await db
    .select({ kind: reviewTasks.kind, n: sql<number>`count(*)::int` })
    .from(reviewTasks)
    .where(eq(reviewTasks.status, "open"))
    .groupBy(reviewTasks.kind);
  const counts = Object.fromEntries(reviewKindEnum.enumValues.map((kind) => [kind, 0])) as Record<ReviewKind, number>;
  for (const row of rows) counts[row.kind] = row.n;
  return counts;
}

const UUID_SQL = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
/** `part` of the subject id (`<a>:<b>`) as a uuid, null when it is none (never a cast error). */
const subjectPart = (part: 1 | 2) =>
  sql`(case when split_part(${reviewTasks.subjectId}, ':', ${sql.raw(String(part))}) ~ ${UUID_SQL}
    then split_part(${reviewTasks.subjectId}, ':', ${sql.raw(String(part))})::uuid end)`;
const placeNameSql = (placeId: SQL) => sql`(select ${displayNameSql(sql`p.geo_object_id`)} from places p where p.id = ${placeId})`;

/**
 * What a task is about, by its subject type (UI-6): the context name (seed, bay or name candidate), else the source's
 * domain, the place's or object's name, both names of a pair, or the failed job's queue.
 */
const subjectNameSql = sql<string | null>`coalesce(${reviewTasks.context}->>'name', case ${reviewTasks.subjectType}
        when 'source' then (select s.domain from sources s where s.id = ${subjectPart(1)})
        when 'place' then ${placeNameSql(subjectPart(1))}
        when 'comparison' then ${placeNameSql(sql`(case when ${reviewTasks.context}->>'placeId' ~ ${UUID_SQL} then (${reviewTasks.context}->>'placeId')::uuid end)`)}
        when 'profile_attribute' then ${displayNameSql(subjectPart(1))}
        when 'profile_summary' then ${displayNameSql(subjectPart(1))}
        when 'geo_object_pair' then concat_ws(' / ', ${displayNameSql(subjectPart(1))}, ${displayNameSql(subjectPart(2))})
        when 'job' then ${reviewTasks.context}->>'queue'
      end)`;

/** Kind and subject name of a task, for its page title (UI-15); null when it does not exist. */
export async function reviewTaskTitle(db: Db, id: string): Promise<{ kind: ReviewKind; name: string | null } | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select({ kind: reviewTasks.kind, name: subjectNameSql }).from(reviewTasks).where(eq(reviewTasks.id, id));
  return row ? { kind: row.kind, name: row.name || null } : null;
}

/** The evaluation filter of the list: only deviations of evaluation runs, or only the rest. */
export type EvaluationFilter = "only" | "none";

/**
 * Open tasks in queue order, optionally of one kind and with or without evaluation deviations (`evaluation`);
 * `before` (a task ID) continues the list after that task. Each row names its subject (`name`, `attribute`).
 */
export async function listOpenTasks(
  db: Db,
  opts: { kind?: ReviewKind; evaluation?: EvaluationFilter; limit: number; before?: string },
): Promise<ReviewTaskRow[]> {
  const evaluation = sql`coalesce(${reviewTasks.context}->>'evaluationRunId', '') <> ''`;
  const conditions: (SQL | undefined)[] = [
    eq(reviewTasks.status, "open"),
    opts.kind ? eq(reviewTasks.kind, opts.kind) : undefined,
    opts.evaluation === "only" ? evaluation : opts.evaluation === "none" ? sql`not ${evaluation}` : undefined,
    opts.before ? afterInQueue(opts.before) : undefined,
  ];
  const t = reviewTasks;
  const rows = await db
    .select({
      id: t.id,
      kind: t.kind,
      subjectType: t.subjectType,
      subjectId: t.subjectId,
      name: subjectNameSql,
      attribute: sql<string | null>`case ${t.subjectType}
        when 'profile_attribute' then nullif(substr(${t.subjectId}, 38), '')
        when 'comparison' then ${t.context}->>'attribute'
      end`,
      evaluation: sql<boolean>`${evaluation}`,
      priority: t.priority,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(and(...conditions))
    .orderBy(...QUEUE_ORDER)
    .limit(opts.limit);
  return rows.map((r) => ({
    ...r,
    name: r.name === "" ? null : r.name,
    attribute: r.attribute !== null && r.subjectType === "profile_attribute" ? profileAttributeLabel(r.attribute) : r.attribute,
  }));
}

/**
 * URL of the next open task of the same kind after `taskId` (for a comparison deviation also of the same class,
 * evaluation or regular), or `/review` when there is none.
 */
export async function nextTaskHref(db: Db, taskId: string): Promise<string> {
  const evaluation = sql<boolean>`coalesce(${reviewTasks.context}->>'evaluationRunId', '') <> ''`;
  const [task] = await db.select({ kind: reviewTasks.kind, evaluation }).from(reviewTasks).where(eq(reviewTasks.id, taskId));
  // a comparison deviation goes on with deviations of the same class: evaluation run or regular profile (UI-6)
  const sameClass = task?.kind === "comparison_deviation" ? (task.evaluation ? evaluation : sql`not ${evaluation}`) : undefined;
  const next = task ? await nextOpenTask(db, task.kind, taskId, sameClass) : null;
  return next ? `/review/${next.id}` : "/review";
}

/** A task with the context of its subject (place, geo object pair, tile, failed job or source); null when unknown. */
export async function reviewTaskDetail(db: Db, id: string): Promise<ReviewTaskDetail | null> {
  const [task] = await db.select().from(reviewTasks).where(eq(reviewTasks.id, id));
  if (!task) return null;
  const context = (task.context ?? {}) as Record<string, unknown>;
  let subject: ReviewSubject;
  switch (task.subjectType) {
    case "place":
      subject = await placeSubject(db, task.subjectId, str(context.helperName), context);
      break;
    case "geo_object_pair":
      subject = await pairSubject(db, task.subjectId, context);
      break;
    case "tile":
      subject = await tileSubject(db, task.subjectId);
      break;
    case "job":
      subject = {
        type: "job",
        job: {
          id: task.subjectId,
          queue: str(context.queue),
          key: str(context.key),
          stage: str(context.stage),
          error: str(context.error),
          runId: str(context.runId),
          sourceId: str(context.sourceId),
        },
      };
      break;
    case "source":
      subject = await sourceSubject(db, task.subjectId, context);
      break;
    case "name_candidate":
      subject = await nameCandidateSubject(db, task.subjectId, context);
      break;
    case "profile_attribute":
      subject = await profileAttributeSubject(db, task.subjectId, context);
      break;
    case "profile_summary":
      subject = await profileSummarySubject(db, task.subjectId, context);
      break;
    case "comparison":
      subject = await comparisonSubject(db, context);
      break;
    default:
      subject = { type: "missing" };
  }
  return {
    task: {
      id: task.id,
      kind: task.kind,
      status: task.status,
      subjectType: task.subjectType,
      subjectId: task.subjectId,
      priority: task.priority,
      createdAt: task.createdAt,
    },
    subject,
  };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);


// Lenient readers of a profile task context (written by consolidateGeo): a part that does not parse is left out.
const conflictSideSchema = z.object({
  value: z.unknown(),
  weight: z.number(),
  factIds: z.array(z.string()),
  observedFrom: z.string(),
  observedTo: z.string(),
});

/** Fact views of the ids that are fact ids (inputs of computations and POIs are cited as `computation:` / `poi:`). */
async function factsOf(db: Db, ids: string[]): Promise<FactView[]> {
  const factIds = [...new Set(ids.filter(isUuid))];
  const views = await factViewsByIds(db, factIds);
  return factIds
    .map((id) => views.get(id))
    .filter((v): v is FactView => v !== undefined)
    .sort((x, y) => (x.observedAt < y.observedAt ? 1 : x.observedAt > y.observedAt ? -1 : 0));
}

async function profileAttributeSubject(db: Db, subjectId: string, context: Record<string, unknown>): Promise<ReviewSubject> {
  const geoObjectId = subjectId.slice(0, 36);
  const attribute = subjectId.slice(37);
  if (!isUuid(geoObjectId) || subjectId[36] !== ":" || attribute === "") return { type: "missing" };
  const { rows } = await db.execute<{ name: string | null }>(sql`
    select ${displayNameSql(sql`o.id`)} as name from geo_objects o where o.id = ${geoObjectId}`);
  if (!rows[0]) return { type: "missing" };
  const profile = await latestProfile(db, geoObjectId);
  const key = str(context.key);

  const side = async (raw: unknown): Promise<ProfileSideView | undefined> => {
    const parsed = conflictSideSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const s = parsed.data as Omit<ConflictSide, "sourceKeys">;
    return {
      value: s.value,
      fingerprint: valueFingerprint(s.value),
      display: formatReviewValue(attribute, s.value),
      weight: s.weight,
      observedFrom: s.observedFrom,
      observedTo: s.observedTo,
      facts: await factsOf(db, s.factIds),
    };
  };
  const current = profile?.attributes[attribute];
  const subject: ProfileAttributeSubject = {
    type: "profile_attribute",
    geoObjectId,
    name: rows[0].name,
    attribute,
    label: profileAttributeLabel(attribute),
    key,
    current: {
      value: current ?? null,
      display: current === undefined ? "–" : formatReviewValue(attribute, current),
      provenance: profile?.provenance[attribute] ?? null,
    },
    resolution: (key && profile?.conflicts.find((c) => c.key === key)?.resolution) || null,
  };
  // a conflict's sides; an uncertain change of a held safety value carries its conflict note in `conflict` (ruling M6-FIN-R3)
  const sides = "a" in context || "b" in context ? context : context.conflict !== null && typeof context.conflict === "object" ? (context.conflict as Record<string, unknown>) : null;
  if (sides) {
    subject.a = await side(sides.a);
    subject.b = await side(sides.b);
    const others = Array.isArray(sides.others) ? await Promise.all(sides.others.map(side)) : [];
    subject.others = others.filter((o): o is ProfileSideView => o !== undefined);
  }
  if ("newValue" in context) {
    const ids = z.array(z.string()).safeParse(context.factIds);
    const cfg = await consolidationConfigFor(db);
    subject.proposed = {
      value: context.newValue,
      display: context.newValue === null ? "–" : formatReviewValue(attribute, context.newValue),
      facts: await factsOf(db, ids.success ? ids.data : []),
      removes: droppedSafetyEntries(attribute, context.oldValue, context.newValue, cfg).map((e) => formatReviewValue(attribute, [e])),
    };
  }
  return subject;
}

async function profileSummarySubject(db: Db, subjectId: string, context: Record<string, unknown>): Promise<ReviewSubject> {
  const [geoObjectId, rawVersion] = [subjectId.slice(0, 36), subjectId.slice(37)];
  const version = Number(rawVersion);
  if (!isUuid(geoObjectId) || subjectId[36] !== ":" || !Number.isInteger(version)) return { type: "missing" };
  const { rows } = await db.execute<{ name: string | null }>(sql`
    select ${displayNameSql(sql`o.id`)} as name from geo_objects o where o.id = ${geoObjectId}`);
  if (!rows[0]) return { type: "missing" };
  const reasons = z.array(z.string()).safeParse(context.reasons);
  return {
    type: "profile_summary",
    geoObjectId,
    name: rows[0].name,
    version,
    attempts: typeof context.attempts === "number" ? context.attempts : null,
    reasons: reasons.success ? reasons.data : [],
  };
}

async function comparisonSubject(db: Db, context: Record<string, unknown>): Promise<ReviewSubject> {
  const parsed = comparisonTaskContextSchema.safeParse(context);
  if (!parsed.success) return { type: "missing" };
  const c = parsed.data;
  const [place] = await db
    .select({
      id: places.id,
      publicId: places.publicId,
      name: displayNameSql(places.geoObjectId),
      kind: places.kind,
      status: places.status,
      position: asGeoJson(places.position),
    })
    .from(places)
    .where(eq(places.id, c.placeId));
  if (!place) return { type: "missing" };
  return {
    type: "comparison",
    place: { ...place, position: lonLat(place.position as Point) },
    attribute: c.attribute,
    valueHash: c.valueHash,
    profileVersion: c.profileVersion,
    evaluationRunId: c.evaluationRunId,
    ownDisplay: c.ownDisplay,
  };
}

// Lenient readers of a source_approval context (written by proposeSources): a part that does not parse is left out.
const serpHitSchema = z.object({
  url: z.string(),
  keyword: z.string(),
  languageCode: z.string(),
  rank: z.number(),
  title: z.string(),
  snippet: z.string(),
});
const proposalRobotsSchema = z.union([
  z.object({ status: z.literal("unavailable") }),
  z.object({
    status: z.enum(["parsed", "allow_all"]),
    disallowAll: z.boolean(),
    blockedStartUrls: z.array(z.string()),
    crawlDelaySec: z.number().nullable(),
    sitemaps: z.number(),
  }),
]);
const suggestionSchema = z.object({
  type: z.enum(DOC_TYPES),
  weight: z.number().min(0).max(1),
  changeRate: z.enum(changeRateEnum.enumValues),
  crawlRules: crawlRulesSchema,
});

async function sourceSubject(db: Db, sourceId: string, context: Record<string, unknown>): Promise<ReviewSubject> {
  if (!isUuid(sourceId)) return { type: "missing" };
  const source = await getSource(db, sourceId);
  if (!source) return { type: "missing" };
  const hits = z.array(serpHitSchema).safeParse(context.hits);
  const languages = z.array(z.string()).safeParse(context.languages);
  const robots = proposalRobotsSchema.safeParse(context.robots);
  const suggestion = suggestionSchema.safeParse(context.suggestion);
  const current: SourceSuggestion = {
    type: source.type,
    weight: source.weight,
    changeRate: source.changeRate,
    crawlRules: source.crawlRules,
  };
  return {
    type: "source",
    source,
    hits: hits.success ? hits.data : [],
    hitCount:
      typeof context.hitCount === "number" ? context.hitCount : hits.success ? hits.data.length : 0,
    linkingSources: typeof context.linkingSources === "number" ? context.linkingSources : 0,
    languages: languages.success ? languages.data : source.languages,
    robots: robots.success ? robots.data : null,
    suggestion: current,
    originalSuggestion: suggestion.success ? suggestion.data : null,
    editedSinceProposal: suggestion.success && canonicalJson(suggestion.data) !== canonicalJson(current),
    settingsKey: sourceSettingsKey(current),
  };
}

// Lenient readers of a name candidate context (written by geocodeCandidate): an entry that does not parse is left out.
const hitSchema = z.object({
  osmId: z.string(),
  name: z.string(),
  lon: z.number(),
  lat: z.number(),
  category: z.string(),
  type: z.string(),
  distanceM: z.number(),
});
const occurrenceSchema = z.object({
  documentId: z.string(),
  versionId: z.string(),
  chunkId: z.string(),
  snippet: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
const lenientArray = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T>[] =>
  Array.isArray(value)
    ? value.flatMap((v) => {
        const parsed = schema.safeParse(v);
        return parsed.success ? [parsed.data as z.infer<T>] : [];
      })
    : [];

async function nameCandidateSubject(db: Db, candidateId: string, context: Record<string, unknown>): Promise<ReviewSubject> {
  if (!isUuid(candidateId)) return { type: "missing" };
  const [candidate] = await db
    .select({
      id: nameCandidates.id,
      name: nameCandidates.displayName,
      hint: nameCandidates.hint,
      tileId: nameCandidates.tileId,
      status: nameCandidates.status,
      documents: nameCandidates.documents,
      sources: nameCandidates.sources,
    })
    .from(nameCandidates)
    .where(eq(nameCandidates.id, candidateId));
  if (!candidate) return { type: "missing" };
  const [tile] = await db.select({ id: tiles.id, bbox: asGeoJson(tiles.bbox) }).from(tiles).where(eq(tiles.id, candidate.tileId));

  const found = lenientArray(occurrenceSchema, context.occurrences);
  const docIds = [...new Set(found.map((o) => o.documentId).filter(isUuid))];
  const urls = docIds.length
    ? new Map(
        (await db.select({ id: documents.id, url: documents.url }).from(documents).where(inArray(documents.id, docIds))).map((d) => [d.id, d.url]),
      )
    : new Map<string, string>();

  // Same candidate space as a valid assign_name target in decideReviewTask.
  const space = await candidateObjects(db, withNeighbours([candidate.tileId], nameCandidateRing()));
  const centre = sql`ST_Centroid(t.bbox)`;
  const { rows: objects } = space.length
    ? await db.execute<{ id: string; name: string | null; type: GeoObjectType; distance_m: number }>(sql`
        select o.id, ${displayNameSql(sql`o.id`)} as name, o.type,
               ST_Distance(o.centroid::geography, ${centre}::geography) as distance_m
        from geo_objects o, tiles t
        where t.id = ${candidate.tileId} and o.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(space)}::jsonb))
        order by distance_m, o.id
        limit ${OBJECT_CHOICES}`)
    : { rows: [] };
  const { rows: nearby } = tile
    ? await db.execute<{ id: string; name: string | null; kind: PlaceKind; status: PlaceStatus; lon: number; lat: number; distance_m: number }>(sql`
        select p.id, ${displayNameSql(sql`p.geo_object_id`)} as name, p.kind, p.status,
               ST_X(p.position) as lon, ST_Y(p.position) as lat,
               ST_Distance(p.position::geography, ${centre}::geography) as distance_m
        from places p, tiles t
        where t.id = ${candidate.tileId}
          and p.valid_to is null and p.merged_into_id is null and p.status in ('candidate', 'confirmed')
        order by distance_m, p.id
        limit ${NEARBY_PLACES}`)
    : { rows: [] };

  return {
    type: "name_candidate",
    candidate,
    tile: tile ? { id: tile.id, bbox: tile.bbox as Polygon } : null,
    objectTypes: Object.fromEntries(placeKindEnum.enumValues.map((k) => [k, newNameObjectType(candidate.hint, k)])) as Record<
      PlaceKind,
      { type: GeoObjectType; category: PoiCategory | null }
    >,
    suggestedKind: suggestedKindForHint(candidate.hint),
    hits: lenientArray(hitSchema, context.hits),
    occurrences: found.map((o) => ({ ...o, url: urls.get(o.documentId) ?? null })),
    objects: objects.map((o) => ({ id: o.id, name: o.name, type: o.type, distanceM: Number(o.distance_m) })),
    nearby: nearby.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      status: r.status,
      position: { lon: Number(r.lon), lat: Number(r.lat) },
      distanceM: Number(r.distance_m),
    })),
  };
}

async function geoObjectViews(db: Db, ids: string[]): Promise<GeoObjectView[]> {
  if (ids.length === 0) return [];
  const objects = await db
    .select({
      id: geoObjects.id,
      type: geoObjects.type,
      origin: geoObjects.origin,
      osmId: geoObjects.osmId,
      wikidataId: geoObjects.wikidataId,
      geonamesId: geoObjects.geonamesId,
      geom: asGeoJson(geoObjects.geom),
    })
    .from(geoObjects)
    .where(inArray(geoObjects.id, ids))
    .orderBy(geoObjects.id);
  const names = await db
    .select({
      geoObjectId: geoNames.geoObjectId,
      name: geoNames.name,
      language: geoNames.language,
      origin: geoNames.origin,
    })
    .from(geoNames)
    .where(and(inArray(geoNames.geoObjectId, ids), isNull(geoNames.validTo)))
    .orderBy(geoNames.language, geoNames.name);
  return objects.map((o) => ({
    ...o,
    names: names
      .filter((n) => n.geoObjectId === o.id)
      .map(({ name, language, origin }) => ({ name, language, origin })),
  }));
}

/**
 * The areas of a restricted-area review: `context.restrictions` (since GR-5), else the single `context.restriction`;
 * kind and share from the context, the dataset reference and the source from `restricted_areas`. Null when the task
 * is no restricted-area review.
 */
async function restrictionViews(db: Db, context: Record<string, unknown>): Promise<RestrictionView[] | null> {
  if (context.reason !== "restricted") return null;
  const listed = Array.isArray(context.restrictions) ? context.restrictions : context.restriction ? [context.restriction] : [];
  const areas = listed
    .map((r) => r as { id?: unknown; kind?: unknown; share?: unknown })
    .filter((r): r is { id: string; kind?: unknown; share?: unknown } => typeof r.id === "string" && isUuid(r.id));
  if (areas.length === 0) return [];
  const { rows } = await db.execute<{ id: string; kind: RestrictedKind; source_ref: string | null; source_name: string | null }>(sql`
    select a.id, a.kind, a.source_ref, s.name as source_name
    from restricted_areas a left join sources s on s.id = a.source_id
    where a.id in (${sql.join(areas.map((a) => sql`${a.id}::uuid`), sql`, `)})`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return areas.map((a) => {
    const row = byId.get(a.id);
    return {
      id: a.id,
      kind: (row?.kind ?? a.kind) as RestrictedKind,
      sourceRef: row?.source_ref ?? null,
      sourceName: row?.source_name ?? null,
      share: typeof a.share === "number" ? a.share : null,
    };
  });
}

async function placeSubject(db: Db, placeId: string, helperName: string | null, context: Record<string, unknown> = {}): Promise<ReviewSubject> {
  if (!isUuid(placeId)) return { type: "missing" };
  const [place] = await db
    .select({
      id: places.id,
      geoObjectId: places.geoObjectId,
      kind: places.kind,
      status: places.status,
      publicId: places.publicId,
      tileId: places.tileId,
      position: asGeoJson(places.position),
    })
    .from(places)
    .where(eq(places.id, placeId));
  if (!place) return { type: "missing" };
  const [geoObject] = await geoObjectViews(db, [place.geoObjectId]);

  // Same filter as a valid merge target in decideReviewTask.
  const { rows } = await db.execute<{
    id: string;
    name: string | null;
    kind: PlaceKind;
    status: PlaceStatus;
    lon: number;
    lat: number;
    distance_m: number;
  }>(sql`
    select p.id, ${displayNameSql(sql`p.geo_object_id`)} as name, p.kind, p.status,
           ST_X(p.position) as lon, ST_Y(p.position) as lat,
           ST_Distance(p.position::geography, s.position::geography) as distance_m
    from places p, places s
    where s.id = ${place.id}
      and p.id <> s.id and p.geo_object_id <> s.geo_object_id
      and p.valid_to is null and p.merged_into_id is null and p.status in ('candidate', 'confirmed')
    order by distance_m, p.id
    limit ${NEARBY_PLACES}`);
  return {
    type: "place",
    place: { ...place, position: lonLat(place.position as Point) },
    geoObject: geoObject!,
    nearby: rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      status: r.status,
      position: { lon: Number(r.lon), lat: Number(r.lat) },
      distanceM: Number(r.distance_m),
    })),
    helperName,
    restrictions: await restrictionViews(db, context),
    facts: (await geoFacts(db, place.geoObjectId, { runs: "active" }))
      .filter((g) => g.facts.length > 0)
      .map((g) => ({ attribute: g.attribute, newest: g.facts[0]!, count: g.facts.length })),
  };
}

async function pairSubject(db: Db, subjectId: string, context: Record<string, unknown>): Promise<ReviewSubject> {
  const ids = subjectId.split(":");
  if (ids.length !== 2 || !ids.every(isUuid)) return { type: "missing" };
  const objects = await geoObjectViews(db, ids);
  const { rows } = await db.execute<{ distance_m: number | null }>(sql`
    select ST_Distance(a.geom::geography, b.geom::geography) as distance_m
    from geo_objects a, geo_objects b where a.id = ${ids[0]} and b.id = ${ids[1]}`);
  const similarity = typeof context.similarity === "number" ? context.similarity : null;
  const distance = rows[0]?.distance_m;
  return {
    type: "geo_object_pair",
    objects,
    distanceM: distance === null || distance === undefined ? null : Number(distance),
    similarity,
  };
}

async function tileSubject(db: Db, tileId: string): Promise<ReviewSubject> {
  const [tile] = await db
    .select({
      id: tiles.id,
      bbox: asGeoJson(tiles.bbox),
      hasCoast: tiles.hasCoast,
      areaId: tiles.areaId,
    })
    .from(tiles)
    .where(eq(tiles.id, tileId));
  if (!tile) return { type: "missing" };
  // Same filter as a valid area in decideReviewTask.
  const { rows } = await db.execute<{
    id: string;
    name: string | null;
    distance_m: number;
  }>(sql`
    select o.id, ${displayNameSql(sql`o.id`)} as name, ST_Distance(o.geom::geography, t.bbox::geography) as distance_m
    from geo_objects o, tiles t
    where t.id = ${tile.id} and o.type = 'area' and o.valid_to is null and o.merged_into_id is null
    order by distance_m, o.id
    limit ${AREA_CHOICES}`);
  return {
    type: "tile",
    tile: { ...tile, bbox: tile.bbox as Polygon },
    areas: rows.map((r) => ({
      id: r.id,
      name: r.name,
      distanceM: Number(r.distance_m),
    })),
  };
}

const lonLat = (p: Point): LonLat => ({
  lon: p.coordinates[0]!,
  lat: p.coordinates[1]!,
});

/** Map features of a task: the subject (role `subject`) and its neighbours or choices (role `nearby`). */
export function detailFeatures(detail: ReviewTaskDetail): GeoJSON.FeatureCollection {
  const feature = (geometry: Geometry, role: string, label: string | null): GeoJSON.Feature => ({
    type: "Feature",
    geometry,
    properties: { role, label: label ?? "" },
  });
  const point = (p: LonLat): Point => ({
    type: "Point",
    coordinates: [p.lon, p.lat],
  });
  const s = detail.subject;
  const features: GeoJSON.Feature[] = [];
  if (s.type === "place") {
    if (s.geoObject.geom.type !== "Point") features.push(feature(s.geoObject.geom, "object", null));
    features.push(feature(point(s.place.position), "subject", s.geoObject.names[0]?.name ?? null));
    for (const n of s.nearby) features.push(feature(point(n.position), "nearby", n.name));
  } else if (s.type === "geo_object_pair") {
    for (const o of s.objects) features.push(feature(o.geom, "subject", o.names[0]?.name ?? null));
  } else if (s.type === "tile") {
    features.push(feature(s.tile.bbox, "subject", s.tile.id));
  } else if (s.type === "comparison") {
    features.push(feature(point(s.place.position), "subject", s.place.name));
  } else if (s.type === "name_candidate") {
    if (s.tile) features.push(feature(s.tile.bbox, "subject", s.tile.id));
    for (const h of s.hits) {
      features.push({ ...feature(point(h), "hit", h.name), properties: { role: "hit", label: h.name, color: "#d97706" } });
    }
    for (const n of s.nearby) features.push(feature(point(n.position), "nearby", n.name));
  }
  return { type: "FeatureCollection", features };
}
