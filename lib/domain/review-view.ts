import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Geometry, Point, Polygon } from "geojson";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import {
  geoNames,
  geoObjects,
  imageryTiles,
  placeRenders,
  places,
  reviewKindEnum,
  reviewTasks,
  tiles,
  type GeoObjectType,
  type GeoOrigin,
  type NameOrigin,
  type PlaceKind,
  type PlaceStatus,
  type ReviewKind,
  type ReviewStatus,
  type RestrictedKind,
  type ImagerySource,
} from "@/lib/db/schema";
import { getConfig } from "@/lib/config";
import type { PlaceImageTaskContext } from "@/lib/pipeline/images/generate";
import { comparisonTaskContextSchema } from "@/lib/domain/quality/comparison-results";
import type { ComparisonAttribute } from "@/lib/db/schema/quality";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { loadImagePlaceInfo, type ImagePlaceInfo } from "@/lib/domain/images/place-info";
import { researchView, type SignalRow } from "@/lib/domain/research/view";
import { afterInQueue, nextOpenTask, QUEUE_ORDER } from "@/lib/domain/review-decisions";

/** Places offered for "merge into a place". */
export const NEARBY_PLACES = 5;
/** Areas offered for a coast tile, nearest first. */
export const AREA_CHOICES = 20;
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
  | ComparisonSubjectView
  | PlaceImageSubjectView
  | ResearchConflictSubjectView
  | { type: "missing" };

/**
 * A `research_conflict` task (plan N3): a confirmed place the reference gate does not know. The place, the threshold the
 * conflict was found at, the verdict now and the pages with signals (quote, domain). Nothing of the reference is shown.
 */
export type ResearchConflictSubjectView = {
  type: "research_conflict";
  place: {
    id: string;
    publicId: string | null;
    name: string | null;
    kind: PlaceKind;
    status: PlaceStatus;
    statusReason: string | null;
    position: LonLat;
  };
  threshold: number | null;
  verdict: { status: string; reason: string; independentSources: string[] };
  evidence: Array<{ url: string; domain: string; signals: SignalRow[] }>;
};

/**
 * A `place_image` task (spec 13): the place (`ImagePlaceInfo`: name, ids, points, composition), the slot, the task's
 * context (camera, checks, attempts, allowed zooms) and the archive keys of the render's photo and mask (null when
 * the task has no render, e.g. `no_water_view`), the imagery sources the render used (core, wide, DEM) and the water
 * IoU threshold of its light.
 */
export type PlaceImageSubjectView = {
  type: "place_image";
  place: ImagePlaceInfo;
  slot: string;
  key: string;
  context: PlaceImageTaskContext;
  candidateKey: string | null;
  photoKey: string | null;
  maskKey: string | null;
  sources: ImagerySource[];
  threshold: number;
};

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
  profileVersion: number | null;
  ownDisplay: string | null;
};

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

/** Open review tasks per kind (every kind present, 0 when none; a retired kind counts 0). */
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
        when 'place' then ${placeNameSql(subjectPart(1))}
        when 'comparison' then ${placeNameSql(sql`(case when ${reviewTasks.context}->>'placeId' ~ ${UUID_SQL} then (${reviewTasks.context}->>'placeId')::uuid end)`)}
        when 'place_image' then ${displayNameSql(subjectPart(1))}
        when 'research_conflict' then ${placeNameSql(subjectPart(1))}
        when 'geo_object_pair' then concat_ws(' / ', ${displayNameSql(subjectPart(1))}, ${displayNameSql(subjectPart(2))})
        when 'job' then ${reviewTasks.context}->>'queue'
      end)`;

/** Kind and subject name of a task, for its page title (UI-15); null when it does not exist. */
export async function reviewTaskTitle(db: Db, id: string): Promise<{ kind: ReviewKind; name: string | null } | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select({ kind: reviewTasks.kind, name: subjectNameSql }).from(reviewTasks).where(eq(reviewTasks.id, id));
  return row ? { kind: row.kind, name: row.name || null } : null;
}

/**
 * Open tasks in queue order, optionally of one kind; `before` (a task ID) continues the list after that task. Each row names its subject (`name`, `attribute`).
 */
export async function listOpenTasks(
  db: Db,
  opts: { kind?: ReviewKind; limit: number; before?: string },
): Promise<ReviewTaskRow[]> {
  const conditions: (SQL | undefined)[] = [
    eq(reviewTasks.status, "open"),
    opts.kind ? eq(reviewTasks.kind, opts.kind) : undefined,
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
        when 'comparison' then ${t.context}->>'attribute'
      end`,
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
  }));
}

/**
 * URL of the next open task of the same kind after `taskId`, or `/review` when there is none.
 */
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
    case "comparison":
      subject = await comparisonSubject(db, context);
      break;
    case "place_image":
      subject = await placeImageSubject(db, task.subjectId, context);
      break;
    case "research_conflict":
      subject = await researchConflictSubject(db, task.subjectId, context);
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
    ownDisplay: c.ownDisplay,
  };
}

async function researchConflictSubject(db: Db, placeId: string, context: Record<string, unknown>): Promise<ReviewSubject> {
  if (!isUuid(placeId)) return { type: "missing" };
  const [place] = await db
    .select({
      id: places.id,
      publicId: places.publicId,
      name: displayNameSql(places.geoObjectId),
      kind: places.kind,
      status: places.status,
      statusReason: places.statusReason,
      position: asGeoJson(places.position),
    })
    .from(places)
    .where(eq(places.id, placeId));
  if (!place) return { type: "missing" };
  const view = await researchView(db, placeId);
  return {
    type: "research_conflict",
    place: { ...place, position: lonLat(place.position as Point) },
    threshold: typeof context.threshold === "number" ? context.threshold : null,
    verdict: { status: view.verdict.status, reason: view.verdict.reason, independentSources: view.verdict.independentSources },
    evidence: view.rows.filter((r) => r.signals.length > 0).map((r) => ({ url: r.url, domain: r.domain, signals: r.signals })),
  };
}

async function placeImageSubject(db: Db, subjectId: string, context: Record<string, unknown>): Promise<ReviewSubject> {
  const [geoObjectId, slot] = [subjectId.slice(0, 36), subjectId.slice(37)];
  if (!isUuid(geoObjectId) || subjectId[36] !== ":" || slot === "" || typeof context.key !== "string") return { type: "missing" };
  const c = context as PlaceImageTaskContext;
  const place = await loadImagePlaceInfo(db, geoObjectId, getConfig().images);
  if (!place) return { type: "missing" };
  const [render] =
    typeof c.renderId === "string" && isUuid(c.renderId)
      ? await db
          .select({ photoKey: placeRenders.photoKey, maskKey: placeRenders.maskKey, imageryTileIds: placeRenders.imageryTileIds, demTileIds: placeRenders.demTileIds })
          .from(placeRenders)
          .where(eq(placeRenders.id, c.renderId))
      : [];
  const tileIds = render ? [...render.imageryTileIds, ...render.demTileIds] : [];
  const tiles =
    tileIds.length === 0
      ? []
      : await db.select({ id: imageryTiles.id, source: imageryTiles.source, blank: imageryTiles.blank }).from(imageryTiles).where(inArray(imageryTiles.id, tileIds));
  const used = tiles.filter((t) => !t.blank).sort((a, b) => tileIds.indexOf(a.id) - tileIds.indexOf(b.id));
  const light = c.light === "evening" ? "evening" : "midday";
  return {
    type: "place_image",
    place,
    slot,
    key: c.key,
    context: c,
    candidateKey: typeof c.candidateKey === "string" ? c.candidateKey : null,
    photoKey: render?.photoKey ?? null,
    maskKey: render?.maskKey ?? null,
    sources: [...new Set(used.map((t) => t.source))],
    threshold: getConfig().images.check.minWaterIoU[light],
  };
}

// Lenient readers of a source_approval context (written by proposeSources): a part that does not parse is left out.
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
  } else if (s.type === "comparison" || s.type === "research_conflict") {
    features.push(feature(point(s.place.position), "subject", s.place.name));
  }
  return { type: "FeatureCollection", features };
}
