import { sql } from "drizzle-orm";
import type { GeometryConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places } from "@/lib/db/schema";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { createReviewTask } from "@/lib/domain/review";
import { tileBbox } from "@/lib/domain/tiles";
import { anchorArea } from "./anchor-area";
import { utmSridFor } from "./projection";
import { waterArea, type LonLat } from "./water";

/**
 * Unnamed bays from geometry (spec 04 „Unbenannte Buchten“, ruling M7-P13), stage `geometry.detect_bays` per tile.
 * Detected bays only ever become place candidates with an open `place_candidate` review task, never confirmed places.
 */

/** One merged group of probe hits: its representative probe (the most enclosed one) in WGS84. */
export type BayCluster = {
  position: LonLat;
  /** Angle (degrees) of the representative's rays that meet land within `rayLengthM`. */
  landDeg: number;
  /** Probe hits merged into this cluster. */
  hits: number;
};

export type DetectBaysResult = {
  /** Coastline samples of the tile. */
  samples: number;
  /** Probes 400 m off the coast in open water. */
  probes: number;
  /** Probes with ≥ `minLandDeg` of land. */
  hits: number;
  clusters: number;
  created: number;
  /** Clusters with a place or a bay/harbour object within `knownPlaceDistanceM`. */
  known: number;
  /** Clusters whose anchor area is below `minAnchorAreaM2`. */
  noAnchorArea: number;
};

type ClusterRow = { samples: number; probes: number; hits: number; clusters: BayCluster[] };

/** Geo object types whose name can serve as the helper name („Bucht bei …“), nearer first; islands only as a fallback. */
const HELPER_TYPES = ["cape", "bay", "harbour", "settlement", "islet", "island"] as const;

/**
 * Probe hits of the tile, merged: the coastline (boundary of the unioned land near the tile, in the tile's UTM zone)
 * sampled every `coastStepM`; at each sample whose point lies in the tile a probe `probeOffsetM` off the coast along
 * the normal on each side whose straight line from the coast stays in water and that is not on land; a probe is a
 * hit when at least `minLandDeg` of its `rayCount` rays (each `rayLengthM`) meet land; hits closer than
 * `mergeDistanceM` (single linkage) form one cluster, represented by its probe with the most land rays (then the one
 * nearest the cluster centre, then the first sample).
 */
export async function bayClusters(db: Db, tileId: string, cfg: GeometryConfig["bays"]): Promise<ClusterRow> {
  const [w, s, e, n] = tileBbox(tileId);
  const srid = utmSridFor((w + e) / 2, (s + n) / 2);
  const margin = cfg.probeOffsetM + cfg.rayLengthM + 100;
  const stepDeg = 360 / cfg.rayCount;
  const minRays = Math.ceil(cfg.minLandDeg / stepDeg - 1e-9);
  const { rows } = await db.execute<{ samples: number; probes: number; hits: number; clusters: BayCluster[] | null }>(sql`
    with env as (
      select ST_Expand(ST_Transform(ST_MakeEnvelope(${w}::float8, ${s}::float8, ${e}::float8, ${n}::float8, 4326), ${srid}::int),
                       ${margin}::float8) as utm
    ),
    land as materialized (
      select ST_Intersection(ST_Union(ST_Transform(l.geom, ${srid}::int)), env.utm) as geom
      from land_polygons l, env
      where l.geom && ST_Transform(env.utm, 4326)
      group by env.utm
    ),
    lines as (
      select row_number() over () as line_id, d.geom as line
      from land, lateral ST_Dump(ST_Boundary(land.geom)) d
      where ST_Length(d.geom) > 0
    ),
    pts as (
      select l.line_id, p.path[1] as i, p.geom
      from lines l,
           lateral ST_DumpPoints(ST_LineInterpolatePoints(l.line, least(1, ${cfg.coastStepM}::float8 / ST_Length(l.line)), true)) p
    ),
    samples as (
      select line_id, i, geom,
             coalesce(lead(geom) over w, geom) as next, coalesce(lag(geom) over w, geom) as prev
      from pts
      window w as (partition by line_id order by i)
    ),
    in_tile as (
      select line_id, i, geom, ST_X(next) - ST_X(prev) as tx, ST_Y(next) - ST_Y(prev) as ty
      from samples
      where tile_id_for(ST_Transform(geom, 4326)) = ${tileId}
    ),
    sides as (
      select line_id, i, geom, side, -ty / len * side as nx, tx / len * side as ny
      from (select *, sqrt(tx * tx + ty * ty) as len from in_tile) t, (values (1), (-1)) v(side)
      where len > 0
    ),
    probes as (
      select row_number() over (order by line_id, i, side) as k, ST_Translate(geom, nx * ${cfg.probeOffsetM}::float8, ny * ${cfg.probeOffsetM}::float8) as probe,
             ST_MakeLine(ST_Translate(geom, nx, ny), ST_Translate(geom, nx * ${cfg.probeOffsetM}::float8, ny * ${cfg.probeOffsetM}::float8)) as reach
      from sides
    ),
    open_probes as (
      select p.k, p.probe from probes p, land where not ST_Intersects(p.reach, land.geom)
    ),
    rays as (
      select o.k, o.probe, count(*) filter (where ST_Intersects(
               ST_MakeLine(o.probe, ST_Translate(o.probe, ${cfg.rayLengthM}::float8 * sin(radians(r * ${stepDeg}::float8)),
                                                          ${cfg.rayLengthM}::float8 * cos(radians(r * ${stepDeg}::float8)))),
               land.geom))::int as land_rays
      from open_probes o, land, generate_series(0, ${cfg.rayCount}::int - 1) r
      group by o.k, o.probe
    ),
    hits as (
      select k, probe, land_rays, ST_ClusterDBSCAN(probe, eps := ${cfg.mergeDistanceM}::float8, minpoints := 1) over () as cid
      from rays where land_rays >= ${minRays}::int
    ),
    centres as (
      select cid, count(*) as members, ST_Centroid(ST_Collect(probe)) as centre from hits group by cid
    ),
    ranked as (
      select h.*, c.members,
             row_number() over (partition by h.cid order by h.land_rays desc, ST_Distance(h.probe, c.centre), h.k) as rank
      from hits h join centres c on c.cid = h.cid
    ),
    reps as (
      select cid, members, land_rays, ST_Transform(probe, 4326) as p from ranked where rank = 1
    )
    select (select count(*)::int from in_tile) as samples,
           (select count(*)::int from open_probes) as probes,
           (select count(*)::int from hits) as hits,
           (select json_agg(json_build_object('position', json_build_object('lon', ST_X(p), 'lat', ST_Y(p)),
                                              'landDeg', land_rays * ${stepDeg}::float8, 'hits', members) order by cid)
              from reps) as clusters`);
  const row = rows[0];
  return {
    samples: Number(row?.samples ?? 0),
    probes: Number(row?.probes ?? 0),
    hits: Number(row?.hits ?? 0),
    clusters: (row?.clusters ?? []).map((c) => ({
      position: { lon: Number(c.position.lon), lat: Number(c.position.lat) },
      landDeg: Number(c.landDeg),
      hits: Number(c.hits),
    })),
  };
}

const pointSql = (p: LonLat) => sql`ST_SetSRID(ST_MakePoint(${p.lon}::float8, ${p.lat}::float8), 4326)`;

/** Whether any place (any status, also ended or merged) or valid bay/harbour object lies within `metres` of `p`. */
async function isKnown(db: Db, p: LonLat, metres: number): Promise<boolean> {
  const { rows } = await db.execute<{ known: boolean }>(sql`
    select exists (
      select 1 from places where ST_DWithin(position::geography, (${pointSql(p)})::geography, ${metres}::float8)
    ) or exists (
      select 1 from geo_objects g
      where g.type in ('bay', 'harbour') and g.valid_to is null and g.merged_into_id is null
        and ST_DWithin(g.geom::geography, (${pointSql(p)})::geography, ${metres}::float8)
    ) as known`);
  return rows[0]!.known;
}

/**
 * Helper name of a detected bay (display only, never a geo name): „Bucht bei <name>“ after the nearest named cape,
 * bay, harbour, settlement or islet within `maxM`, else the nearest named island within `maxM`; null without one.
 */
export async function bayHelperName(db: Db, p: LonLat, maxM: number): Promise<string | null> {
  const { rows } = await db.execute<{ name: string }>(sql`
    select name from (
      select ${displayNameSql(sql`g.id`)} as name, g.type = 'island' as fallback,
             ST_Distance(g.geom::geography, (${pointSql(p)})::geography) as d
      from geo_objects g
      where g.type in ${HELPER_TYPES} and g.valid_to is null and g.merged_into_id is null
        and ST_DWithin(g.geom::geography, (${pointSql(p)})::geography, ${maxM}::float8)
    ) t
    where name is not null
    order by fallback, d
    limit 1`);
  return rows[0] ? `Bucht bei ${rows[0].name}` : null;
}

/**
 * Stage `geometry.detect_bays` for one tile: finds the bay clusters (`bayClusters`, read only), then in one
 * transaction serialised against the same stage of other tiles (advisory lock, so two tiles never create the same bay
 * twice) creates for every cluster that is new — no place of any status and no bay or harbour object within
 * `knownPlaceDistanceM` — and has an anchor area (water circle of `water.bayRadiusM` minus land, `anchorArea`) of at
 * least `minAnchorAreaM2`: a geo object (type `bay`, origin `computed`, a point, no names), its tile link, a place
 * (`anchorage`, status `candidate`) and an open `place_candidate` review task whose context carries the helper name
 * („Bucht bei …“, `name` and `helperName`) and the detection values. A rerun creates nothing new (the places exist,
 * also when rejected); exclusions by restricted areas follow in the geometry stage of the same run.
 */
export async function detectTileBays(db: Db, tileId: string, cfg: GeometryConfig): Promise<DetectBaysResult> {
  const found = await bayClusters(db, tileId, cfg.bays);
  const result: DetectBaysResult = {
    samples: found.samples,
    probes: found.probes,
    hits: found.hits,
    clusters: found.clusters.length,
    created: 0,
    known: 0,
    noAnchorArea: 0,
  };
  if (found.clusters.length === 0) return result;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('geometry.detect_bays'))`);
    for (const c of found.clusters) {
      if (await isKnown(tx, c.position, cfg.bays.knownPlaceDistanceM)) {
        result.known++;
        continue;
      }
      const geom = geomFromGeoJson({ type: "Point", coordinates: [c.position.lon, c.position.lat] });
      const water = await waterArea(tx, { geom: { type: "Point", coordinates: [c.position.lon, c.position.lat] }, center: c.position, isHarbour: false }, cfg.water);
      const area = water.geometry ? await anchorArea(tx, water.geometry, cfg.anchorArea) : null;
      const anchorAreaM2 = area?.areaM2 ?? 0;
      if (anchorAreaM2 < cfg.bays.minAnchorAreaM2) {
        result.noAnchorArea++;
        continue;
      }
      const helperName = await bayHelperName(tx, c.position, cfg.bays.helperNameMaxDistanceM);
      const [object] = await tx
        .insert(geoObjects)
        .values({ type: "bay", origin: "computed", geom: sql`${geom}` })
        .returning({ id: geoObjects.id });
      const [place] = await tx
        .insert(places)
        .values({ geoObjectId: object!.id, kind: "anchorage", status: "candidate", position: sql`${geom}` })
        .returning({ id: places.id, tileId: places.tileId });
      await tx.execute(sql`
        insert into tile_geo_objects (tile_id, geo_object_id)
        select t.id, ${object!.id}::uuid from tiles t where t.id = ${place!.tileId} and t.valid_to is null
        on conflict do nothing`);
      await createReviewTask(tx, {
        kind: "place_candidate",
        subjectType: "place",
        subjectId: place!.id,
        context: {
          geoObjectId: object!.id,
          kind: "anchorage",
          tileId: place!.tileId,
          name: helperName,
          helperName,
          detected: { landDeg: c.landDeg, hits: c.hits, anchorAreaM2 },
        },
      });
      result.created++;
    }
    return result;
  });
}
