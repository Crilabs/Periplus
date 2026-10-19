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
} from "@/lib/db/schema";
import type { ProposalRobots, SerpHit } from "@/lib/domain/discovery/proposals";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { candidateObjects, withNeighbours } from "@/lib/domain/mentions/scope";
import {
  afterInQueue,
  NAME_CANDIDATE_RING,
  newNameObjectType,
  nextOpenTask,
  QUEUE_ORDER,
} from "@/lib/domain/review-decisions";
import { crawlRulesSchema, type CrawlRules } from "@/lib/domain/sources/crawl-rules";
import { getSource, type Source } from "@/lib/domain/sources/store";

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
  /** Display name from the task context (place candidates), if any. */
  name: string | null;
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
      /** Suggested approval values; the source's current values when the task has none. */
      suggestion: SourceSuggestion;
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
      hits: NominatimHit[];
      occurrences: NameOccurrenceView[];
      /** Valid objects of the candidate space (tile and neighbours), nearest to the tile centre first. */
      objects: Array<{ id: string; name: string | null; type: GeoObjectType; distanceM: number }>;
      /** Places nearest to the tile centre. */
      nearby: NearbyPlace[];
    }
  | { type: "missing" };

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

/** Open tasks in queue order, optionally of one kind; `before` (a task ID) continues the list after that task. */
export async function listOpenTasks(
  db: Db,
  opts: { kind?: ReviewKind; limit: number; before?: string },
): Promise<ReviewTaskRow[]> {
  const conditions: (SQL | undefined)[] = [
    eq(reviewTasks.status, "open"),
    opts.kind ? eq(reviewTasks.kind, opts.kind) : undefined,
    opts.before ? afterInQueue(opts.before) : undefined,
  ];
  const rows = await db
    .select({
      id: reviewTasks.id,
      kind: reviewTasks.kind,
      subjectType: reviewTasks.subjectType,
      subjectId: reviewTasks.subjectId,
      name: sql<string | null>`${reviewTasks.context}->>'name'`,
      priority: reviewTasks.priority,
      createdAt: reviewTasks.createdAt,
    })
    .from(reviewTasks)
    .where(and(...conditions))
    .orderBy(...QUEUE_ORDER)
    .limit(opts.limit);
  return rows;
}

/** URL of the next open task of the same kind after `taskId`, or `/review` when there is none. */
export async function nextTaskHref(db: Db, taskId: string): Promise<string> {
  const [task] = await db.select({ kind: reviewTasks.kind }).from(reviewTasks).where(eq(reviewTasks.id, taskId));
  const next = task ? await nextOpenTask(db, task.kind, taskId) : null;
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
      subject = await placeSubject(db, task.subjectId);
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
  return {
    type: "source",
    source,
    hits: hits.success ? hits.data : [],
    hitCount:
      typeof context.hitCount === "number" ? context.hitCount : hits.success ? hits.data.length : 0,
    linkingSources: typeof context.linkingSources === "number" ? context.linkingSources : 0,
    languages: languages.success ? languages.data : source.languages,
    robots: robots.success ? robots.data : null,
    suggestion: suggestion.success
      ? suggestion.data
      : { type: source.type, weight: source.weight, changeRate: source.changeRate, crawlRules: source.crawlRules },
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
  const space = await candidateObjects(db, withNeighbours([candidate.tileId], NAME_CANDIDATE_RING));
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

async function placeSubject(db: Db, placeId: string): Promise<ReviewSubject> {
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
  } else if (s.type === "name_candidate") {
    if (s.tile) features.push(feature(s.tile.bbox, "subject", s.tile.id));
    for (const h of s.hits) {
      features.push({ ...feature(point(h), "hit", h.name), properties: { role: "hit", label: h.name, color: "#d97706" } });
    }
    for (const n of s.nearby) features.push(feature(point(n.position), "nearby", n.name));
  }
  return { type: "FeatureCollection", features };
}
