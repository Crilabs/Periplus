import { and, asc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Geometry } from "geojson";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places, type ComputationKind, type PlaceStatus } from "@/lib/db/schema";
import { recordComputation, type ComputedFact } from "@/lib/domain/facts/computations";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { anchorArea, type AnchorArea } from "@/lib/domain/geometry/anchor-area";
import { depthConfidence, depthRange, sampleDepths } from "@/lib/domain/geometry/depth";
import type { Gap, GapReason } from "@/lib/domain/geometry/gaps";
import { computeFetch } from "@/lib/domain/geometry/rays";
import { applyExclusion, exclusionFor, restrictionHits } from "@/lib/domain/geometry/restrictions";
import { seabedShares } from "@/lib/domain/geometry/seabed";
import { opening, sectorFetch, shelterFromFetch, swellProtection } from "@/lib/domain/geometry/shelter";
import { resolveOrigin, waterArea, type LonLat } from "@/lib/domain/geometry/water";
import { tileBbox } from "@/lib/domain/tiles";
import { validAt } from "@/lib/domain/timeline";
import { seedTileIds } from "@/lib/pipeline/tile-scope";

// No import of ./runs here: the job handler imports this module (import cycle through the stage registry).

export const GEOMETRY_STAGE = "geometry.place";

export { GAP_REASONS, type Gap, type GapReason } from "@/lib/domain/geometry/gaps";

export type PlaceGeometryResult = {
  created: ComputationKind[];
  unchanged: ComputationKind[];
  gaps: Gap[];
  excluded: boolean;
};

/** Place statuses the geometry stage computes. */
const COMPUTED_STATUSES: PlaceStatus[] = ["candidate", "confirmed", "no_anchoring"];

const EMPTY_AREA: AnchorArea = { geometry: null, areaM2: 0, position: null, key: "empty" };

/** Metres per degree of latitude (and of longitude at the equator), for index boxes only. */
const METRES_PER_DEGREE = 111_320;

const round = (value: number, places: number) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};
const roundPoint = (p: LonLat, places: number): LonLat => ({ lon: round(p.lon, places), lat: round(p.lat, places) });

const pointSql = (p: LonLat): SQL => sql`ST_SetSRID(ST_MakePoint(${p.lon}::float8, ${p.lat}::float8), 4326)`;

/** Index box: `geom` expanded by `metres` in degrees (longitude widened for the latitude `lat`). */
function expandSql(geom: SQL, metres: number, lat: number): SQL {
  const dLat = metres / METRES_PER_DEGREE;
  const dLon = dLat / Math.max(Math.cos((Math.min(Math.abs(lat) + dLat, 89) * Math.PI) / 180), 0.01);
  return sql`ST_Expand(${geom}, ${dLon}::float8, ${dLat}::float8)`;
}

/** Whether any land polygon lies within `metres` of `geom` (WGS84, its latitude about `lat`). */
async function hasLandWithin(db: Db, geom: SQL, metres: number, lat: number): Promise<boolean> {
  const { rows } = await db.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from land_polygons l
      where l.geom && ${expandSql(geom, metres, lat)} and ST_DWithin(l.geom::geography, (${geom})::geography, ${metres}::float8)
    ) as found`);
  return rows[0]!.found;
}

/** Throws unless every tile of `tileIds` has bathymetry rows ("Datensätze laden" ran for it). */
async function assertBathymetry(db: Db, tileIds: string[]): Promise<void> {
  const { rows } = await db.execute<{ tile_id: string }>(sql`
    select distinct tile_id from bathymetry where tile_id in (select unnest(${`{${tileIds.join(",")}}`}::text[]))`);
  const imported = new Set(rows.map((r) => r.tile_id));
  const missing = tileIds.filter((id) => !imported.has(id));
  if (missing.length > 0) throw new Error(`bathymetry not imported for tile ${missing.join(", ")} – run Datensätze laden`);
}

/**
 * Checks the inputs the geometry stage needs for `tileIds` (before a run exists): bathymetry rows for every
 * tile and land polygons within the ray length of every tile. Throws naming the tiles that lack them.
 */
export async function checkGeometryTiles(db: Db, tileIds: string[]): Promise<void> {
  if (tileIds.length === 0) return;
  await assertBathymetry(db, tileIds);
  const maxRayM = getConfig().geometry.fetch.maxRayM;
  const withoutLand: string[] = [];
  for (const id of tileIds) {
    const [w, s, e, n] = tileBbox(id);
    const box = sql`ST_MakeEnvelope(${w}::float8, ${s}::float8, ${e}::float8, ${n}::float8, 4326)`;
    if (!(await hasLandWithin(db, box, maxRayM, Math.max(Math.abs(s), Math.abs(n))))) withoutLand.push(id);
  }
  if (withoutLand.length > 0) {
    throw new Error(`land polygons missing within ${maxRayM / 1000} km of tile ${withoutLand.join(", ")} – import the land polygons`);
  }
}

/**
 * Places the geometry stage computes: valid, unmerged places with status candidate, confirmed or no_anchoring
 * whose tile is one of `params.tileIds`, else one of the coast tiles of the area `params.areaKey`; ordered by id.
 */
export async function geometryPlaceIds(db: Db, params: { tileIds?: string[]; areaKey?: string }): Promise<string[]> {
  const tileIds = await seedTileIds(db, params);
  if (tileIds.length === 0) return [];
  const rows = await db
    .select({ id: places.id })
    .from(places)
    .where(
      and(
        inArray(places.tileId, tileIds),
        validAt(places),
        isNull(places.mergedIntoId),
        inArray(places.status, COMPUTED_STATUSES),
      ),
    )
    .orderBy(asc(places.id));
  return rows.map((r) => r.id);
}

type PlaceInput = {
  geoObjectId: string;
  geoObjectType: string;
  geom: Geometry;
  kind: string;
  status: PlaceStatus;
  current: boolean;
  tileId: string | null;
  position: LonLat;
  anchor: { position: LonLat; origin: string | null } | null;
};

/**
 * Writes the computed anchor (or clears it) unless a review anchor is there: the guard is part of the update itself,
 * so a correction committed after the stage read the place is never overwritten.
 */
export async function storeComputedAnchor(db: Db, placeId: string, anchor: LonLat | null, confidence: number): Promise<void> {
  await db
    .update(places)
    .set(
      anchor
        ? { anchorPosition: sql`${pointSql(anchor)}`, anchorConfidence: confidence, anchorOrigin: "computed" }
        : { anchorPosition: null, anchorConfidence: null, anchorOrigin: null },
    )
    .where(and(eq(places.id, placeId), or(isNull(places.anchorOrigin), ne(places.anchorOrigin, "review"))));
}

/**
 * Loads the place and locks its row, so an admin anchor correction cannot commit between this read and the write.
 * Global lock order (as in `decideReviewTask` and `applyExclusion`): the open `place_candidate` review task row
 * first, then the place row. The stage takes the task lock here, before the place, although only a later
 * exclusion writes the task; otherwise the stage (place → task) and a decision (task → place) can deadlock.
 */
async function loadPlace(db: Db, placeId: string): Promise<PlaceInput | null> {
  await db.execute(sql`
    select id from review_tasks
    where kind = 'place_candidate' and subject_id = ${placeId} and status = 'open'
    for update`);
  const { rows } = await db.execute<{
    geo_object_id: string;
    type: string;
    geom: Geometry;
    kind: string;
    status: PlaceStatus;
    current: boolean;
    tile_id: string | null;
    lon: number;
    lat: number;
    anchor_lon: number | null;
    anchor_lat: number | null;
    anchor_origin: string | null;
  }>(sql`
    select g.id as geo_object_id, g.type, ST_AsGeoJSON(g.geom)::json as geom, places.kind, places.status,
           (${validAt(places)} and places.merged_into_id is null) as current, places.tile_id,
           ST_X(places.position) as lon, ST_Y(places.position) as lat,
           ST_X(places.anchor_position) as anchor_lon, ST_Y(places.anchor_position) as anchor_lat, places.anchor_origin
    from places join geo_objects g on g.id = places.geo_object_id
    where places.id = ${placeId}
    for update of places`);
  const r = rows[0];
  if (!r) return null;
  return {
    geoObjectId: r.geo_object_id,
    geoObjectType: r.type,
    geom: r.geom,
    kind: r.kind,
    status: r.status,
    current: r.current,
    tileId: r.tile_id,
    position: { lon: Number(r.lon), lat: Number(r.lat) },
    anchor:
      r.anchor_lon === null || r.anchor_lat === null
        ? null
        : { position: { lon: Number(r.anchor_lon), lat: Number(r.anchor_lat) }, origin: r.anchor_origin },
  };
}

type RasterRef = { dataset: string; version: string; resolutionM: number };

/** Dataset, version and resolution of the bathymetry rasters intersecting `geom`, sorted. */
async function rastersIntersecting(db: Db, geom: SQL): Promise<RasterRef[]> {
  const { rows } = await db.execute<{ dataset: string; version: string; resolution_m: number }>(sql`
    with t as (select ${geom} as geom)
    select distinct b.dataset, b.dataset_version as version, b.resolution_m
    from bathymetry b, t
    where ST_ConvexHull(b.rast) && t.geom and ST_Intersects(ST_ConvexHull(b.rast), t.geom)
    order by b.dataset, b.dataset_version, b.resolution_m`);
  return rows.map((r) => ({ dataset: r.dataset, version: r.version, resolutionM: Number(r.resolution_m) }));
}

/** Sorted dataset versions of the land polygons within `metres` of `geom`. */
async function landVersionsNear(db: Db, geom: SQL, metres: number, lat: number): Promise<string[]> {
  const { rows } = await db.execute<{ versions: string[] | null }>(sql`
    select array_agg(distinct l.dataset_version order by l.dataset_version) as versions
    from land_polygons l
    where l.geom && ${expandSql(geom, metres, lat)} and ST_DWithin(l.geom::geography, (${geom})::geography, ${metres}::float8)`);
  return rows[0]!.versions ?? [];
}

/** Points `distancesM` from `origin` along `bearingDeg` (same projection as `sampleDepths`). */
async function samplePoints(db: Db, origin: LonLat, bearingDeg: number, distancesM: number[]): Promise<LonLat[]> {
  if (distancesM.length === 0) return [];
  const { rows } = await db.execute<{ lon: number; lat: number }>(sql`
    select ST_X(p) as lon, ST_Y(p) as lat
    from (
      select d.i, ST_Project(${pointSql(origin)}::geography, d.dist, radians(${bearingDeg}::float8))::geometry as p
      from unnest(${`{${distancesM.join(",")}}`}::float8[]) with ordinality as d(dist, i)
    ) t
    order by i`);
  return rows.map((r) => roundPoint({ lon: Number(r.lon), lat: Number(r.lat) }, 7));
}

/** Nearest valid settlement and nearest road to `p`, with distances in whole metres. */
async function quietnessInputs(db: Db, p: LonLat) {
  const point = pointSql(p);
  const [settlement] = await db
    .select({ id: geoObjects.id, distanceM: sql<number>`ST_Distance(${geoObjects.geom}::geography, (${point})::geography)` })
    .from(geoObjects)
    .where(and(eq(geoObjects.type, "settlement"), validAt(geoObjects), isNull(geoObjects.mergedIntoId)))
    .orderBy(sql`${geoObjects.geom} <-> ${point}`)
    .limit(1);
  const { rows } = await db.execute<{ osm_id: string; dataset_version: string; distance_m: number }>(sql`
    select osm_id, dataset_version, ST_Distance(geom::geography, (${point})::geography) as distance_m
    from roads order by geom <-> ${point} limit 1`);
  const road = rows[0];
  return {
    settlementId: settlement?.id ?? null,
    settlementDistanceM: settlement ? Math.round(Number(settlement.distanceM)) : null,
    roadOsmId: road?.osm_id ?? null,
    roadsVersion: road?.dataset_version ?? null,
    roadDistanceM: road ? Math.round(Number(road.distance_m)) : null,
  };
}

const sameAnchor = (a: LonLat | null, b: LonLat | null) =>
  a === null || b === null ? a === b : Math.abs(a.lon - b.lon) < 1e-9 && Math.abs(a.lat - b.lat) < 1e-9;

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Stage `geometry.place` for one place, in one transaction (spec 04). Writes one computation per kind through
 * `recordComputation` (nothing when its inputs equal the newest row), in this order:
 * 1. `anchor_area` (always): water area and anchor area (water with anchoring depth, clear of land), facts
 *    `anchor_area` and `anchor_position` when the area is not empty; gaps `no_water` / `origin_unresolved`
 *    (for `shelter.*`, `fetch.*`) and `no_anchor_area`.
 * 2. `fetch`, 3. `shelter`, 4. `depth` — only with an origin: the review anchor, else this run's computed anchor,
 *    else the place position (moved off land).
 * 5. `seabed` (with water) on the anchor area, else the water area.
 * 6. `restriction` (always): fact `prohibitions` for the anchor area, else the origin (or position).
 * 7. `quietness` (always): distances to the nearest settlement and road, no fact.
 * The computed anchor position is written to the place (confidence 0.3, origin `computed`) unless an admin set
 * it; afterwards an anchoring ban covering more than `minShare` excludes the place (`applyExclusion`).
 * Throws when the place's tile has no bathymetry or no land lies within the ray length. A place that ended,
 * was merged or has another status is skipped (empty result).
 */
export async function computePlaceGeometry(
  db: Db,
  placeId: string,
  opts: { runId?: string; today?: string } = {},
): Promise<PlaceGeometryResult> {
  const config = getConfig();
  const cfg = config.geometry;
  const today = opts.today ?? todayIso();
  const banConfig = {
    noAnchoringKinds: config.gazetteer.noAnchoringKinds,
    protectedAreaAnchoringBan: config.restrictions.protectedAreaAnchoringBan,
  };

  return db.transaction(async (tx) => {
    const place = await loadPlace(tx, placeId);
    if (!place) throw new Error(`Unknown place ${placeId}`);
    const result: PlaceGeometryResult = { created: [], unchanged: [], gaps: [], excluded: false };
    if (!place.current || !COMPUTED_STATUSES.includes(place.status)) return result;

    if (!place.tileId) throw new Error(`place ${placeId} has no tile`);
    await assertBathymetry(tx, [place.tileId]);
    if (!(await hasLandWithin(tx, pointSql(place.position), cfg.fetch.maxRayM, place.position.lat))) {
      throw new Error(`land polygons missing within ${cfg.fetch.maxRayM / 1000} km of place ${placeId} – import the land polygons`);
    }

    const record = async (
      kind: ComputationKind,
      inputs: Record<string, unknown>,
      facts: ComputedFact[],
      outputs?: Record<string, unknown>,
    ) => {
      const r = await recordComputation(tx, {
        geoObjectId: place.geoObjectId,
        kind,
        inputs,
        outputs,
        rulesVersion: cfg.rulesVersion,
        facts,
        observedAt: today,
        runId: opts.runId,
      });
      (r.created ? result.created : result.unchanged).push(kind);
      return r;
    };

    // 1. Water and anchor area: they depend on water, bathymetry and land only, never on the origin (M2-P1).
    const isHarbour = place.geoObjectType === "harbour" || place.kind === "port" || place.kind === "marina";
    const water = await waterArea(tx, { geom: place.geom, center: place.position, isHarbour }, cfg.water);
    const area = water.geometry ? await anchorArea(tx, water.geometry, cfg.anchorArea) : EMPTY_AREA;
    const computedAnchor = area.position ? roundPoint(area.position, 7) : null;
    const resolved = await resolveOrigin(
      tx,
      { position: place.position, anchor: place.anchor, computedAnchor, water },
      cfg.water,
    );
    const origin = resolved ? roundPoint(resolved.origin, 6) : null;

    const areaGaps: Gap[] = [];
    if (!water.geometry) {
      areaGaps.push({ attribute: "shelter.*", reason: "no_water" }, { attribute: "fetch.*", reason: "no_water" });
    } else if (!origin) {
      areaGaps.push(
        { attribute: "shelter.*", reason: "origin_unresolved" },
        { attribute: "fetch.*", reason: "origin_unresolved" },
      );
    }
    if (!area.geometry) {
      areaGaps.push({ attribute: "anchor_area", reason: "no_anchor_area" }, { attribute: "anchor_position", reason: "no_anchor_area" });
    }
    const isPoint = place.geom.type === "Point" || place.geom.type === "MultiPoint";
    const waterReachM = (isPoint ? (isHarbour ? cfg.water.harbourRadiusM : cfg.water.bayRadiusM) : 0) + cfg.anchorArea.landClearanceM;
    const waterBase = isPoint ? pointSql(place.position) : geomFromGeoJson(place.geom);
    await record(
      "anchor_area",
      {
        waterKey: water.key,
        landVersions: await landVersionsNear(tx, waterBase, waterReachM, place.position.lat),
        bathymetry: water.geometry ? await rastersIntersecting(tx, geomFromGeoJson(water.geometry)) : [],
        params: cfg.anchorArea,
      },
      area.geometry && computedAnchor
        ? [
            { attribute: "anchor_area", value: { areaM2: area.areaM2 }, confidence: cfg.anchorArea.positionConfidence },
            { attribute: "anchor_position", value: computedAnchor, confidence: cfg.anchorArea.positionConfidence },
          ]
        : [],
      { water: water.geometry, area: area.geometry, gaps: areaGaps },
    );
    result.gaps.push(...areaGaps);

    // The computed anchor goes to the place unless an admin set one.
    if (place.anchor === null || place.anchor.origin === null || place.anchor.origin === "computed") {
      const stored = place.anchor?.position ?? null;
      if (!sameAnchor(stored, computedAnchor)) {
        await storeComputedAnchor(tx, placeId, computedAnchor, cfg.anchorArea.positionConfidence);
      }
    }

    // 2.–4. Fetch, shelter and depth from the origin.
    if (origin && resolved && water.geometry) {
      const fetched = await computeFetch(tx, origin, cfg);
      const fetchSectors = sectorFetch(fetched.rays, cfg);
      const fetchRow = await record(
        "fetch",
        { origin, originSource: resolved.source, srid: fetched.srid, landVersions: fetched.landVersions, params: cfg.fetch },
        SECTORS.map((s) => ({ attribute: `fetch.${s}`, value: fetchSectors[s], confidence: cfg.fetch.confidence })),
        { rays: fetched.rays },
      );

      const shelter = shelterFromFetch(fetched.rays, cfg);
      const open = opening(fetched.rays, cfg);
      await record(
        "shelter",
        { fetchComputationId: fetchRow.id, params: { shelter: cfg.shelter, opening: cfg.opening, swell: cfg.swell } },
        [
          ...SECTORS.map((s) => ({ attribute: `shelter.${s}`, value: shelter[s], confidence: cfg.shelter.confidence })),
          { attribute: "swell_protection", value: swellProtection(fetched.rays, shelter, cfg), confidence: cfg.swell.confidence },
          { attribute: "opening_bearing", value: open, confidence: cfg.opening.confidence },
        ],
      );

      const longest = Math.max(...fetched.rays);
      const bearingDeg = open.bearingDeg ?? fetched.rays.indexOf(longest) * cfg.fetch.rayStepDeg;
      const distances = cfg.depth.sampleDistancesM;
      const depths = await sampleDepths(tx, origin, bearingDeg, distances);
      const points = await samplePoints(tx, origin, bearingDeg, distances);
      const waterRange = await depthRange(tx, water.geometry);
      const anchorRange = area.geometry ? await depthRange(tx, area.geometry) : null;
      const reach = Math.max(0, ...distances);
      const rasters = await rastersIntersecting(
        tx,
        sql`ST_Union(${geomFromGeoJson(water.geometry)}, ST_Buffer((${pointSql(origin)})::geography, ${reach}::float8)::geometry)`,
      );
      const coarsest = rasters.length > 0 ? Math.max(...rasters.map((r) => r.resolutionM)) : null;

      const depthFacts: ComputedFact[] = [];
      const depthGaps: Gap[] = [];
      const approachResolution = waterRange?.resolutionM ?? coarsest;
      if (depths.some((d) => d !== null) && approachResolution !== null) {
        depthFacts.push({
          attribute: "depth.approach",
          value: Object.fromEntries(distances.map((d, i) => [`at${d}m`, depths[i] ?? null])),
          confidence: depthConfidence(approachResolution, water.widthM, cfg.depth),
        });
      } else {
        depthGaps.push({ attribute: "depth.approach", reason: "no_bathymetry" });
      }
      if (waterRange) {
        const confidence = depthConfidence(waterRange.resolutionM, water.widthM, cfg.depth);
        depthFacts.push(
          { attribute: "depth.min", value: waterRange.min, confidence },
          { attribute: "depth.max", value: waterRange.max, confidence },
        );
      } else {
        depthGaps.push({ attribute: "depth.min", reason: "no_bathymetry" }, { attribute: "depth.max", reason: "no_bathymetry" });
      }
      if (anchorRange) {
        const confidence = depthConfidence(anchorRange.resolutionM, water.widthM, cfg.depth);
        depthFacts.push(
          { attribute: "depth.anchoring_min", value: anchorRange.min, confidence },
          { attribute: "depth.anchoring_max", value: anchorRange.max, confidence },
        );
      } else {
        const reason: GapReason = area.geometry ? "no_bathymetry" : "no_anchor_area";
        depthGaps.push({ attribute: "depth.anchoring_min", reason }, { attribute: "depth.anchoring_max", reason });
      }
      await record(
        "depth",
        { origin, bearingDeg, waterKey: water.key, anchorAreaKey: area.key, bathymetry: rasters, params: cfg.depth },
        depthFacts,
        {
          samples: points.map((p, i) => ({ distanceM: distances[i], lon: p.lon, lat: p.lat, depthM: depths[i] ?? null })),
          gaps: depthGaps,
        },
      );
      result.gaps.push(...depthGaps);
    }

    // 5. Seabed on the anchor area, else the water area.
    if (water.geometry) {
      const target = area.geometry ? "anchor_area" : "water";
      const seabed = await seabedShares(tx, area.geometry ?? water.geometry);
      const covered = seabed.shares.length > 0 && seabed.coverage >= cfg.seabed.minCoverage;
      const seabedGaps: Gap[] = covered ? [] : [{ attribute: "seabed", reason: "no_seabed_coverage" }];
      await record(
        "seabed",
        { target, targetKey: area.geometry ? area.key : water.key, seabedVersions: seabed.versions },
        covered ? [{ attribute: "seabed", value: seabed.shares, confidence: cfg.seabed.confidence }] : [],
        { coverage: round(seabed.coverage, 3), gaps: seabedGaps },
      );
      result.gaps.push(...seabedGaps);
    }

    // 6. Restricted areas over the anchor area, else the origin (or the position without one).
    const targetPosition = origin ?? roundPoint(place.position, 6);
    const hits = await restrictionHits(tx, { area: area.geometry, position: targetPosition }, banConfig);
    const prohibitions = hits.map((h) => ({
      kind: h.kind,
      restrictedAreaId: h.restrictedAreaId,
      sourceRef: h.sourceRef,
      share: round(h.share, 4),
      anchoringBan: h.anchoringBan,
    }));
    await record(
      "restriction",
      {
        targetKey: area.geometry ? area.key : `point:${targetPosition.lon},${targetPosition.lat}`,
        // The share is part of the inputs: a restricted area whose geometry changed keeps its id.
        restrictedAreas: prohibitions.map((p) => ({ id: p.restrictedAreaId, kind: p.kind, share: p.share })),
        params: { minShare: cfg.restriction.minShare, ...banConfig },
      },
      [{ attribute: "prohibitions", value: prohibitions, confidence: cfg.restriction.confidence }],
    );

    // 7. Quietness pre-stage: distance to the nearest settlement and road, no fact (M5 computes the value).
    const quietness = await quietnessInputs(tx, targetPosition);
    await record(
      "quietness",
      {
        origin: targetPosition,
        settlementId: quietness.settlementId,
        roadOsmId: quietness.roadOsmId,
        roadsVersion: quietness.roadsVersion,
      },
      [],
      { settlementDistanceM: quietness.settlementDistanceM, roadDistanceM: quietness.roadDistanceM },
    );

    const exclusion = exclusionFor(hits, cfg.restriction.minShare);
    if (exclusion) result.excluded = (await applyExclusion(tx, placeId, exclusion)) === "excluded";
    return result;
  });
}
