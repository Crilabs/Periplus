import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Point, Polygon } from "geojson";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import { externalCalls, geoNames, geoObjects, places, reviewTasks, runs, tileGeoObjects, tiles, type GeoObjectType, type GeoOrigin, type NameOrigin, type NameScript, type PlaceKind, type PlaceWebsiteOrigin, type PlaceStatus, type PoiCategory, type ReviewKind, type RunKind, type RunScopeType, type RunStatus, subdivisions } from "@/lib/db/schema";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { currentPlaceWebsite } from "@/lib/domain/places/websites";
import { derivedBerthable } from "@/lib/domain/consolidation/berthable";
import { latestProfile, validAt } from "@/lib/domain/timeline";

/** Runs shown on a tile page. */
export const TILE_RUNS = 10;
/** Guard against a cyclic parent chain. */
const MAX_DEPTH = 32;

export type LonLat = { lon: number; lat: number };
export type GeoObjectRef = { id: string; type: GeoObjectType; name: string | null };
export type PlaceRef = { id: string; name: string | null; kind: PlaceKind; status: PlaceStatus };

export type TileDetail = {
  tile: {
    id: string;
    bbox: Polygon;
    subdivisionId: string | null;
    hasCoast: boolean;
    priority: number;
    cycleDays: number;
    lastRunAt: Date | null;
    nextRunAt: Date | null;
    validTo: string | null;
  };
  /** The subdivision the tile is labelled with (most coastline); its sailing areas are among `geoObjects`. */
  subdivision: { key: string; name: string | null } | null;
  geoObjects: GeoObjectRef[];
  places: PlaceRef[];
  runs: Array<{
    id: string;
    kind: RunKind;
    scopeType: RunScopeType;
    scopeId: string;
    status: RunStatus;
    stages: string[];
    createdAt: Date;
    finishedAt: Date | null;
  }>;
  costs: Array<{ service: string; calls: number; costEur: number }>;
  costEur: number;
};

export type GeoObjectDetail = {
  object: {
    id: string;
    type: GeoObjectType;
    name: string | null;
    origin: GeoOrigin;
    publicId: string | null;
    configKey: string | null;
    category: PoiCategory | null;
    osmId: string | null;
    wikidataId: string | null;
    geonamesId: string | null;
    mergedIntoId: string | null;
    validFrom: string;
    validTo: string | null;
    /** For the page's map; simplified to about 50 m so large regions stay small. */
    geometry: GeoJSON.Geometry;
  };
  names: Array<{
    name: string;
    language: string;
    script: NameScript;
    origin: NameOrigin;
    isPreferred: boolean;
    valid: boolean;
    validFrom: string;
    validTo: string | null;
  }>;
  /** Parent first, root last. */
  ancestors: GeoObjectRef[];
  /** Valid children. */
  children: GeoObjectRef[];
  place: { id: string; kind: PlaceKind; status: PlaceStatus } | null;
  tileIds: string[];
};

export type PlaceDetail = {
  place: {
    id: string;
    name: string | null;
    geoObjectId: string;
    kind: PlaceKind;
    status: PlaceStatus;
    statusReason: string | null;
    publicId: string | null;
    tileId: string | null;
    position: LonLat;
    mergedIntoId: string | null;
    validTo: string | null;
  };
  openReviewTask: { id: string; kind: ReviewKind } | null;
  /** Status changes newest first: `status` is the status the place had until `changedAt`. */
  statusHistory: Array<{ status: PlaceStatus; changedAt: Date }>;
  /** The newest automatic decision of the system (spec 17): status decisions before kind switches; null for none. */
  autoDecision: AutoDecision | null;
  /** The place's current website (newest `place_websites` row); null for none. */
  website: { url: string; origin: PlaceWebsiteOrigin; bound: boolean } | null;
  /** The `berthable` the delivery gives the place: the profile's value, else the derivation of spec 17; null = unknown. */
  berthable: boolean | null;
};

export type AutoDecision = {
  /** `candidate`: the research rule withdrew a confirmation (plan N2). */
  action: "confirm" | "no_anchoring" | "candidate" | "set_kind";
  rule: string | null;
  decidedAt: Date;
  factIds: string[];
  documentIds: string[];
  routeStopIds: string[];
};

/** True for a valid tile with this id. */
export async function tileExists(db: Db, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tiles.id })
    .from(tiles)
    .where(and(eq(tiles.id, id), validAt(tiles)));
  return row !== undefined;
}

/** A tile with its subdivision label, geo objects, places, the last runs touching it and its costs; null when unknown. */
export async function tileDetail(db: Db, id: string): Promise<TileDetail | null> {
  const [tile] = await db
    .select({
      id: tiles.id,
      bbox: asGeoJson(tiles.bbox),
      subdivisionId: tiles.subdivisionId,
      hasCoast: tiles.hasCoast,
      priority: tiles.priority,
      cycleDays: tiles.cycleDays,
      lastRunAt: tiles.lastRunAt,
      nextRunAt: tiles.nextRunAt,
      validTo: tiles.validTo,
    })
    .from(tiles)
    .where(eq(tiles.id, id));
  if (!tile) return null;

  const objectName = displayNameSql(geoObjects.id);
  const placeName = displayNameSql(places.geoObjectId);
  // One query after the other: `db` may be a transaction (one connection), where parallel queries are not allowed.
  const subdivision = tile.subdivisionId
    ? await db
        .select({ key: subdivisions.key, name: displayNameSql(subdivisions.geoObjectId) })
        .from(subdivisions)
        .where(eq(subdivisions.id, tile.subdivisionId))
        .then((rows) => rows[0] ?? null)
    : null;
  const objects = await db
    .select({ id: geoObjects.id, type: geoObjects.type, name: objectName })
    .from(tileGeoObjects)
    .innerJoin(geoObjects, eq(geoObjects.id, tileGeoObjects.geoObjectId))
    .where(and(eq(tileGeoObjects.tileId, id), validAt(geoObjects)))
    .orderBy(sql`${objectName} nulls last`, asc(geoObjects.id));
  const placeRows = await db
    .select({ id: places.id, name: placeName, kind: places.kind, status: places.status })
    .from(places)
    .where(and(eq(places.tileId, id), validAt(places)))
    .orderBy(sql`${placeName} nulls last`, asc(places.id));
  const runRows = await db
    .select({
      id: runs.id,
      kind: runs.kind,
      scopeType: runs.scopeType,
      scopeId: runs.scopeId,
      status: runs.status,
      stages: runs.stages,
      createdAt: runs.createdAt,
      finishedAt: runs.finishedAt,
    })
    .from(runs)
    .where(
      sql`(${runs.scopeType} = 'tile' and ${runs.scopeId} = ${id}) or ${runs.params}->'tileIds' @> ${JSON.stringify([id])}::jsonb`,
    )
    .orderBy(desc(runs.id))
    .limit(TILE_RUNS);
  const costRows = await db
    .select({
      service: externalCalls.service,
      calls: sql<number>`count(*)::int`,
      costEur: sql<string>`coalesce(sum(${externalCalls.costEur}), 0)`,
    })
    .from(externalCalls)
    .where(eq(externalCalls.tileId, id))
    .groupBy(externalCalls.service)
    .orderBy(externalCalls.service);
  const costs = costRows.map((r) => ({ service: r.service, calls: r.calls, costEur: Number(r.costEur) }));
  return {
    tile: { ...tile, bbox: tile.bbox as Polygon },
    subdivision,
    geoObjects: objects,
    places: placeRows,
    runs: runRows,
    costs,
    costEur: costs.reduce((sum, c) => sum + c.costEur, 0),
  };
}

/** A geo object with all names, its parent chain, children, place and tiles; null when unknown. */
export async function geoObjectDetail(db: Db, id: string): Promise<GeoObjectDetail | null> {
  const [object] = await db
    .select({
      id: geoObjects.id,
      type: geoObjects.type,
      name: displayNameSql(geoObjects.id),
      origin: geoObjects.origin,
      publicId: geoObjects.publicId,
      configKey: geoObjects.configKey,
      category: geoObjects.category,
      osmId: geoObjects.osmId,
      wikidataId: geoObjects.wikidataId,
      geonamesId: geoObjects.geonamesId,
      mergedIntoId: geoObjects.mergedIntoId,
      validFrom: geoObjects.validFrom,
      validTo: geoObjects.validTo,
      geometry: asGeoJson(sql`ST_SimplifyPreserveTopology(${geoObjects.geom}, 0.0005)`),
    })
    .from(geoObjects)
    .where(eq(geoObjects.id, id));
  if (!object) return null;

  const objectName = displayNameSql(geoObjects.id);
  // One query after the other: `db` may be a transaction (one connection), where parallel queries are not allowed.
  const names = await db
    .select({
      name: geoNames.name,
      language: geoNames.language,
      script: geoNames.script,
      origin: geoNames.origin,
      isPreferred: geoNames.isPreferred,
      valid: sql<boolean>`${validAt(geoNames)}`,
      validFrom: geoNames.validFrom,
      validTo: geoNames.validTo,
    })
    .from(geoNames)
    .where(eq(geoNames.geoObjectId, id))
    .orderBy(desc(validAt(geoNames)), geoNames.language, desc(geoNames.isPreferred), geoNames.name);
  const ancestors = await db
    .execute<{ id: string; type: GeoObjectType; name: string | null }>(
      sql`
      with recursive chain (id, depth) as (
        select o.parent_id, 1 from geo_objects o where o.id = ${id} and o.parent_id is not null
        union all
        select o.parent_id, c.depth + 1 from chain c join geo_objects o on o.id = c.id
        where o.parent_id is not null and c.depth < ${MAX_DEPTH}
      )
      select o.id, o.type, ${displayNameSql(sql`o.id`)} as name
      from chain c join geo_objects o on o.id = c.id
      order by c.depth`,
    )
    .then((r) => r.rows.map(({ id, type, name }) => ({ id, type, name })));
  const children = await db
    .select({ id: geoObjects.id, type: geoObjects.type, name: objectName })
    .from(geoObjects)
    .where(and(eq(geoObjects.parentId, id), validAt(geoObjects)))
    .orderBy(sql`${objectName} nulls last`, asc(geoObjects.id));
  const place = await db
    .select({ id: places.id, kind: places.kind, status: places.status })
    .from(places)
    .where(eq(places.geoObjectId, id))
    .then((rows) => rows[0] ?? null);
  const tileRows = await db
    .select({ tileId: tileGeoObjects.tileId })
    .from(tileGeoObjects)
    .where(eq(tileGeoObjects.geoObjectId, id))
    .orderBy(tileGeoObjects.tileId);
  return { object, names, ancestors, children, place, tileIds: tileRows.map((r) => r.tileId) };
}

const STATUS_ACTIONS = new Set(["confirm", "reject", "no_anchoring"]);

/**
 * The automatic decision the place page shows (final review 6): the newest status decision of the place (a
 * `place_status` decision by anyone, or a `confirm` / `reject` / `no_anchoring` decision of a review task on the place)
 * when `system` made it; else the newest kind decision (a `place_kind` decision, or a review `confirm`, which sets the
 * kind) when `system` made it; null otherwise. An admin's later decision hides the system's.
 */
async function latestAutoDecision(db: Db, placeId: string): Promise<AutoDecision | null> {
  const { rows } = await db.execute<{ subject_type: string; decision: Record<string, unknown>; decided_by: string; decided_at: Date | string }>(sql`
    select t.subject_type, d.decision, d.decided_by, d.decided_at
    from review_tasks t join review_decisions d on d.task_id = t.id
    where t.kind = 'place_candidate' and t.subject_type in ('place', 'place_status', 'place_kind') and t.subject_id = ${placeId}
    order by d.decided_at desc, d.id desc
  `);
  const action = (r: (typeof rows)[number]) => r.decision.action;
  const status = rows.find((r) => r.subject_type === "place_status" || (r.subject_type === "place" && STATUS_ACTIONS.has(action(r) as string)));
  const kind = rows.find((r) => r.subject_type === "place_kind" || (r.subject_type === "place" && action(r) === "confirm"));
  const row = status?.decided_by === "system" ? status : kind?.decided_by === "system" ? kind : null;
  if (!row) return null;
  const ids = (key: string) => (Array.isArray(row.decision[key]) ? (row.decision[key] as string[]) : []);
  return {
    action: row.decision.action as AutoDecision["action"],
    rule: typeof row.decision.rule === "string" ? row.decision.rule : null,
    decidedAt: new Date(row.decided_at),
    factIds: ids("factIds"),
    documentIds: ids("documentIds"),
    routeStopIds: ids("routeStopIds"),
  };
}

/** A place with its open review task and status history; null when unknown. */
export async function placeDetail(db: Db, id: string): Promise<PlaceDetail | null> {
  const [place] = await db
    .select({
      id: places.id,
      name: displayNameSql(places.geoObjectId),
      geoObjectId: places.geoObjectId,
      kind: places.kind,
      status: places.status,
      statusReason: places.statusReason,
      publicId: places.publicId,
      tileId: places.tileId,
      position: asGeoJson(places.position),
      mergedIntoId: places.mergedIntoId,
      validTo: places.validTo,
    })
    .from(places)
    .where(eq(places.id, id));
  if (!place) return null;

  // One query after the other: `db` may be a transaction (one connection), where parallel queries are not allowed.
  const task = await db
    .select({ id: reviewTasks.id, kind: reviewTasks.kind })
    .from(reviewTasks)
    .where(and(eq(reviewTasks.subjectType, "place"), eq(reviewTasks.subjectId, id), eq(reviewTasks.status, "open")))
    .orderBy(reviewTasks.createdAt, reviewTasks.id)
    .limit(1)
    .then((rows) => rows[0] ?? null);
  // A history row holds the row before a core-column change; keep only rows whose status differs from the next state.
  const history = await db.execute<{ status: PlaceStatus; changed_at: Date | string }>(sql`
    select status, changed_at from (
      select h.history_id, h.old_row->>'status' as status, h.changed_at,
             coalesce(lead(h.old_row->>'status') over (order by h.changed_at, h.history_id), ${place.status}) as next_status
      from places_history h where h.row_id = ${id}
    ) s
    where status is distinct from next_status
    order by changed_at desc, history_id desc`);
  const [lon, lat] = (place.position as Point).coordinates;
  const website = await currentPlaceWebsite(db, id);
  const berthableFact = ((await latestProfile(db, place.geoObjectId))?.attributes as Record<string, unknown> | undefined)?.["berthable"];
  return {
    place: { ...place, position: { lon: lon!, lat: lat! } },
    openReviewTask: task,
    statusHistory: history.rows.map((r) => ({ status: r.status, changedAt: new Date(r.changed_at) })),
    autoDecision: await latestAutoDecision(db, id),
    website: website ? { url: website.url, origin: website.origin, bound: website.bound } : null,
    berthable: typeof berthableFact === "boolean" ? berthableFact : derivedBerthable(place.kind, place.status),
  };
}

/** The geo object of the place `placeId`; null when the place does not exist. */
export async function placeGeoObjectId(db: Db, placeId: string): Promise<string | null> {
  const [place] = await db.select({ geoObjectId: places.geoObjectId }).from(places).where(eq(places.id, placeId));
  return place?.geoObjectId ?? null;
}

/** Whether the place `placeId` belongs to the geo object `geoObjectId` (a form posted from a place page names both). */
export async function placeBelongsTo(db: Db, placeId: string, geoObjectId: string): Promise<boolean> {
  const [place] = await db.select({ id: places.id }).from(places).where(and(eq(places.id, placeId), eq(places.geoObjectId, geoObjectId)));
  return place !== undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The display name of a place's object, for its page title (UI-15); null when unknown or unnamed. */
export async function placeTitle(db: Db, placeId: string): Promise<string | null> {
  if (!UUID_RE.test(placeId)) return null;
  const [row] = await db.select({ name: displayNameSql(places.geoObjectId) }).from(places).where(eq(places.id, placeId));
  return row?.name ?? null;
}

/** The display name of a geo object, for its page title (UI-15); null when unknown or unnamed. */
export async function geoObjectTitle(db: Db, geoObjectId: string): Promise<string | null> {
  if (!UUID_RE.test(geoObjectId)) return null;
  const [row] = await db.select({ name: displayNameSql(geoObjects.id) }).from(geoObjects).where(eq(geoObjects.id, geoObjectId));
  return row?.name ?? null;
}
