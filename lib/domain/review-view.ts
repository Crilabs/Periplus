import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Geometry, Point, Polygon } from "geojson";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import {
  geoNames,
  geoObjects,
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
} from "@/lib/db/schema";
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
      };
    }
  | { type: "missing" };

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

/** A task with the context of its subject (place, geo object pair, tile or failed job); null when unknown. */
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
        },
      };
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

/** Preferred display name of a geo object: German, then English, then any; preferred names first. */
const displayName = (geoObjectId: SQL) => sql<string | null>`(
  select n.name from geo_names n
  where n.geo_object_id = ${geoObjectId} and n.valid_to is null
  order by case n.language when 'de' then 0 when 'en' then 1 else 2 end, n.is_preferred desc, n.name
  limit 1
)`;

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
    select p.id, ${displayName(sql`p.geo_object_id`)} as name, p.kind, p.status,
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
    select o.id, ${displayName(sql`o.id`)} as name, ST_Distance(o.geom::geography, t.bbox::geography) as distance_m
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
  }
  return { type: "FeatureCollection", features };
}
