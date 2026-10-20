import { sql } from "drizzle-orm";
import type { GeometryConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places } from "@/lib/db/schema";
import { assignParentOf } from "@/lib/domain/gazetteer/hierarchy";
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

/** One probe hit: its position in the tile's UTM zone (metres) and in WGS84, and its rays that meet land. */
export type BayHit = {
  /** Stable index of the probe within the tile (coastline, sample, side). */
  k: number;
  x: number;
  y: number;
  position: LonLat;
  landRays: number;
};

/** One merged group of probe hits: its representative probe (the most enclosed one), in UTM and in WGS84. */
export type BayCluster = {
  /** Key of the representative probe. */
  k: number;
  x: number;
  y: number;
  position: LonLat;
  /** Angle (degrees) of the representative's rays that meet land within `rayLengthM`. */
  landDeg: number;
  /** Probe hits merged into this cluster. */
  hits: number;
};

export type DetectBaysResult = {
  /** Coastline samples near the tile (within `probeOffsetM` of it). */
  samples: number;
  /** Probes 400 m off the coast in open water, inside the tile. */
  probes: number;
  /** Probes with ≥ `minLandDeg` of land. */
  hits: number;
  /** Hits with a place or a known object (`knownObjectTypes`) within `knownPlaceDistanceM`, dropped before clustering. */
  knownHits: number;
  /** Further hits claimed by a known place's own bay (`claimedHitKeys`), dropped before clustering too. */
  claimedHits: number;
  /** Clusters of the remaining hits. */
  clusters: number;
  created: number;
  /** Clusters within `knownPlaceDistanceM` of a candidate created before in the same pass, skipped. */
  duplicates: number;
  /** Clusters whose anchor area is below `minAnchorAreaM2`. */
  noAnchorArea: number;
};

type HitRow = { samples: number; probes: number; hits: BayHit[] };

/**
 * Probe hits of the tile: the coastline (boundary of the unioned land near the tile, in the tile's UTM zone) sampled
 * every `coastStepM`; at each sample within `probeOffsetM` of the tile a probe `probeOffsetM` off the coast along the
 * normal on each side whose straight line from the coast stays in water, that is not on land and that lies inside the
 * tile (so every probe belongs to exactly one tile, and every representative lies in the tile that creates it); a probe
 * is a hit when at least `minLandDeg` of its `rayCount` rays (each `rayLengthM`) meet land.
 */
export async function bayHits(db: Db, tileId: string, cfg: GeometryConfig["bays"]): Promise<HitRow> {
  const [w, s, e, n] = tileBbox(tileId);
  const srid = utmSridFor((w + e) / 2, (s + n) / 2);
  // samples up to probeOffsetM outside the tile, rays up to rayLengthM beyond the probe; 100 m slack
  const margin = 2 * cfg.probeOffsetM + cfg.rayLengthM + 100;
  const stepDeg = 360 / cfg.rayCount;
  const minRays = Math.ceil(cfg.minLandDeg / stepDeg - 1e-9);
  const { rows } = await db.execute<{ samples: number; probes: number; hits: BayHit[] | null }>(sql`
    with tile as (
      select ST_Transform(ST_Segmentize(ST_MakeEnvelope(${w}::float8, ${s}::float8, ${e}::float8, ${n}::float8, 4326), 0.01), ${srid}::int) as utm
    ),
    env as (
      select ST_Expand(tile.utm, ${margin}::float8) as utm from tile
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
    near_tile as (
      select line_id, i, geom, ST_X(next) - ST_X(prev) as tx, ST_Y(next) - ST_Y(prev) as ty
      from samples, tile
      where ST_DWithin(samples.geom, tile.utm, ${cfg.probeOffsetM}::float8)
    ),
    sides as (
      select line_id, i, geom, side, -ty / len * side as nx, tx / len * side as ny
      from (select *, sqrt(tx * tx + ty * ty) as len from near_tile) t, (values (1), (-1)) v(side)
      where len > 0
    ),
    probes as (
      select row_number() over (order by line_id, i, side) as k, ST_Translate(geom, nx * ${cfg.probeOffsetM}::float8, ny * ${cfg.probeOffsetM}::float8) as probe,
             ST_MakeLine(ST_Translate(geom, nx, ny), ST_Translate(geom, nx * ${cfg.probeOffsetM}::float8, ny * ${cfg.probeOffsetM}::float8)) as reach
      from sides
    ),
    open_probes as (
      select p.k, p.probe from probes p, land
      where tile_id_for(ST_Transform(p.probe, 4326)) = ${tileId} and not ST_Intersects(p.reach, land.geom)
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
      select k, probe, land_rays, ST_Transform(probe, 4326) as p from rays where land_rays >= ${minRays}::int
    )
    select (select count(*)::int from near_tile) as samples,
           (select count(*)::int from open_probes) as probes,
           (select json_agg(json_build_object('k', k, 'x', ST_X(probe), 'y', ST_Y(probe), 'landRays', land_rays,
                                              'position', json_build_object('lon', ST_X(p), 'lat', ST_Y(p))) order by k)
              from hits) as hits`);
  const row = rows[0];
  return {
    samples: Number(row?.samples ?? 0),
    probes: Number(row?.probes ?? 0),
    hits: (row?.hits ?? []).map((h) => ({
      k: Number(h.k),
      x: Number(h.x),
      y: Number(h.y),
      position: { lon: Number(h.position.lon), lat: Number(h.position.lat) },
      landRays: Number(h.landRays),
    })),
  };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Single-linkage groups of hits at most `mergeDistanceM` apart, in the order of their first hit. */
function linkGroups(hits: BayHit[], mergeDistanceM: number): BayHit[][] {
  const parent = hits.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const byX = hits.map((_, i) => i).sort((a, b) => hits[a]!.x - hits[b]!.x);
  for (let a = 0; a < byX.length; a++) {
    const ha = hits[byX[a]!]!;
    for (let b = a + 1; b < byX.length; b++) {
      const hb = hits[byX[b]!]!;
      if (hb.x - ha.x > mergeDistanceM) break;
      if (dist(ha, hb) <= mergeDistanceM) parent[find(byX[a]!)] = find(byX[b]!);
    }
  }
  const groups = new Map<number, BayHit[]>();
  hits.forEach((h, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), h]);
  });
  return [...groups.values()];
}

/**
 * Keys of the hits a known place's own bay claims (pure, ruling M7-I-R2): a hit that is not known itself, lies within
 * `knownBayDistanceM` of a place or known object (`near`) and is single-linked (`mergeDistanceM`, over all hits) to a
 * known hit. The wings of a 1–2 km bay with a known place at its head so stay with that place, while a side cove further
 * down a gulf (beyond `knownBayDistanceM`) or a separate bay (not linked) stays free.
 */
export function claimedHitKeys(
  hits: BayHit[],
  known: ReadonlySet<number>,
  near: ReadonlySet<number>,
  mergeDistanceM: number,
): Set<number> {
  const claimed = new Set<number>();
  for (const group of linkGroups(hits, mergeDistanceM)) {
    if (!group.some((h) => known.has(h.k))) continue;
    for (const h of group) if (!known.has(h.k) && near.has(h.k)) claimed.add(h.k);
  }
  return claimed;
}

/**
 * Creation order of the clusters with the same-pass dedupe (pure): the most enclosed first (most land, then lowest `k`);
 * a cluster within `knownPlaceDistanceM` of one kept before is dropped, so two groups 300–500 m apart (e.g. the two
 * walls of a narrow gulf) give one candidate. `each` creates a cluster and says whether it was created (it had an
 * anchor area); only created clusters suppress later ones.
 */
export async function inCreationOrder(
  clusters: BayCluster[],
  knownPlaceDistanceM: number,
  each: (c: BayCluster) => Promise<boolean>,
): Promise<{ duplicates: number }> {
  const kept: BayCluster[] = [];
  let duplicates = 0;
  for (const c of [...clusters].sort((a, b) => b.landDeg - a.landDeg || a.k - b.k)) {
    if (kept.some((o) => dist(o, c) < knownPlaceDistanceM)) {
      duplicates++;
      continue;
    }
    if (await each(c)) kept.push(c);
  }
  return { duplicates };
}

/**
 * Merges hits (pure): hits at most `mergeDistanceM` apart form one group (single linkage); each group is then cut into
 * pieces greedily — the hit with the most land rays (then the one nearest the group's centre, then the lowest `k`)
 * that no piece holds yet represents a new piece, which takes every free hit of the group within `maxClusterSpanM / 2`
 * of it. A compact bay stays one cluster; a long chain of hits along a gulf or channel becomes one cluster per stretch
 * of at most `maxClusterSpanM`, so a side cove gets its own representative. Ordered by the representative's `k`.
 */
export function clusterHits(
  hits: BayHit[],
  cfg: Pick<GeometryConfig["bays"], "mergeDistanceM" | "maxClusterSpanM" | "rayCount">,
): BayCluster[] {
  const groups = linkGroups(hits, cfg.mergeDistanceM);

  const radius = cfg.maxClusterSpanM / 2;
  const stepDeg = 360 / cfg.rayCount;
  const out: { k: number; cluster: BayCluster }[] = [];
  for (const members of groups.values()) {
    const centre = {
      x: members.reduce((sum, h) => sum + h.x, 0) / members.length,
      y: members.reduce((sum, h) => sum + h.y, 0) / members.length,
    };
    const ranked = [...members].sort((a, b) => b.landRays - a.landRays || dist(a, centre) - dist(b, centre) || a.k - b.k);
    const taken = new Set<number>();
    for (const rep of ranked) {
      if (taken.has(rep.k)) continue;
      const piece = ranked.filter((h) => !taken.has(h.k) && dist(h, rep) <= radius);
      for (const h of piece) taken.add(h.k);
      out.push({
        k: rep.k,
        cluster: { k: rep.k, x: rep.x, y: rep.y, position: rep.position, landDeg: rep.landRays * stepDeg, hits: piece.length },
      });
    }
  }
  return out.sort((a, b) => a.k - b.k).map((c) => c.cluster);
}

/** Probe hits of the tile (`bayHits`), merged (`clusterHits`) without the known check; read only. */
export async function bayClusters(
  db: Db,
  tileId: string,
  cfg: GeometryConfig["bays"],
): Promise<Omit<HitRow, "hits"> & { hits: number; clusters: BayCluster[] }> {
  const found = await bayHits(db, tileId, cfg);
  return { samples: found.samples, probes: found.probes, hits: found.hits.length, clusters: clusterHits(found.hits, cfg) };
}

const pointSql = (p: LonLat) => sql`ST_SetSRID(ST_MakePoint(${p.lon}::float8, ${p.lat}::float8), 4326)`;

/**
 * Keys (`k`) of the hits with a place (any status, also ended or merged, so also every bay detected earlier) or a valid
 * object of `knownObjectTypes` within `distanceM`.
 */
async function hitKeysNearKnown(db: Db, hits: BayHit[], distanceM: number, cfg: GeometryConfig["bays"]): Promise<Set<number>> {
  if (hits.length === 0) return new Set();
  const points = JSON.stringify(hits.map((h) => ({ k: h.k, lon: h.position.lon, lat: h.position.lat })));
  // bbox prefilter in degrees: metres / 50 km per degree over-covers longitude up to ~60°
  const deg = distanceM / 50_000;
  const { rows } = await db.execute<{ k: number }>(sql`
    with h as (
      select (e->>'k')::int as k, ST_SetSRID(ST_MakePoint((e->>'lon')::float8, (e->>'lat')::float8), 4326) as p
      from jsonb_array_elements(${points}::jsonb) e
    )
    select h.k from h
    where exists (
      select 1 from places pl
      where pl.position && ST_Expand(h.p, ${deg}::float8)
        and ST_DWithin(pl.position::geography, h.p::geography, ${distanceM}::float8)
    ) or exists (
      select 1 from geo_objects g
      where g.type::text in ${cfg.knownObjectTypes} and g.valid_to is null and g.merged_into_id is null
        and g.geom && ST_Expand(h.p, ${deg}::float8)
        and ST_DWithin(g.geom::geography, h.p::geography, ${distanceM}::float8)
    )`);
  return new Set(rows.map((r) => Number(r.k)));
}

/**
 * Helper name of a detected bay (display only, never a geo name): „Bucht bei <name>“ after the nearest named object
 * within `maxM` of the first tier of `tiers` (`helperNameTypes`, e.g. cape … islet, then islands as a fallback) that
 * has one; null without one.
 */
export async function bayHelperName(db: Db, p: LonLat, maxM: number, tiers: string[][]): Promise<string | null> {
  const tierOf = sql.join(
    tiers.map((types, i) => sql`when g.type::text in ${types} then ${i}::int`),
    sql` `,
  );
  // bbox prefilter in degrees (as `hitKeysNearKnown`), so the GiST index on geo_objects.geom serves the search
  const deg = maxM / 50_000;
  const { rows } = await db.execute<{ name: string }>(sql`
    select name from (
      select ${displayNameSql(sql`g.id`)} as name, case ${tierOf} end as tier,
             ST_Distance(g.geom::geography, (${pointSql(p)})::geography) as d
      from geo_objects g
      where g.type::text in ${tiers.flat()} and g.valid_to is null and g.merged_into_id is null
        and g.geom && ST_Expand(${pointSql(p)}, ${deg}::float8)
        and ST_DWithin(g.geom::geography, (${pointSql(p)})::geography, ${maxM}::float8)
    ) t
    where name is not null
    order by tier, d
    limit 1`);
  return rows[0] ? `Bucht bei ${rows[0].name}` : null;
}

/**
 * Stage `geometry.detect_bays` for one tile: finds the probe hits (`bayHits`, read only), then in one transaction
 * serialised against the same stage of other tiles (advisory lock, so the known check sees every bay a neighbouring
 * tile detected before) drops the hits that are known — a place of any status or a `knownObjectTypes` object within
 * `knownPlaceDistanceM` — and the hits a known place's own bay claims (`claimedHitKeys`, `knownBayDistanceM`), merges
 * the rest (`clusterHits`) and creates, most enclosed first and skipping a cluster within `knownPlaceDistanceM` of one
 * created before in the same pass (`inCreationOrder`), for every cluster with an anchor area (water
 * circle of `water.bayRadiusM` minus land, `anchorArea`) of at least `minAnchorAreaM2`: a geo object (type `bay`,
 * origin `computed`, a point, no names, its parent by the hierarchy rule), its tile link, a place (`anchorage`, status
 * `candidate`) and an open `place_candidate` review task whose context carries the helper name („Bucht bei …“, `name`
 * and `helperName`) and the detection values. Every representative lies in the tile, so the place stage of the same run
 * computes its geometry and exclusions. A rerun creates nothing near an existing place (also when rejected); a stretch
 * that had no anchor area can be cut differently on a rerun once its neighbour became known.
 */
export async function detectTileBays(db: Db, tileId: string, cfg: GeometryConfig): Promise<DetectBaysResult> {
  const found = await bayHits(db, tileId, cfg.bays);
  const result: DetectBaysResult = {
    samples: found.samples,
    probes: found.probes,
    hits: found.hits.length,
    knownHits: 0,
    claimedHits: 0,
    clusters: 0,
    created: 0,
    duplicates: 0,
    noAnchorArea: 0,
  };
  if (found.hits.length === 0) return result;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('geometry.detect_bays'))`);
    const known = await hitKeysNearKnown(tx, found.hits, cfg.bays.knownPlaceDistanceM, cfg.bays);
    const near = await hitKeysNearKnown(tx, found.hits, cfg.bays.knownBayDistanceM, cfg.bays);
    const claimed = claimedHitKeys(found.hits, known, near, cfg.bays.mergeDistanceM);
    result.knownHits = known.size;
    result.claimedHits = claimed.size;
    const clusters = clusterHits(
      found.hits.filter((h) => !known.has(h.k) && !claimed.has(h.k)),
      cfg.bays,
    );
    result.clusters = clusters.length;
    const { duplicates } = await inCreationOrder(clusters, cfg.bays.knownPlaceDistanceM, async (c) => {
      const geom = geomFromGeoJson({ type: "Point", coordinates: [c.position.lon, c.position.lat] });
      const water = await waterArea(tx, { geom: { type: "Point", coordinates: [c.position.lon, c.position.lat] }, center: c.position, isHarbour: false }, cfg.water);
      const area = water.geometry ? await anchorArea(tx, water.geometry, cfg.anchorArea) : null;
      const anchorAreaM2 = area?.areaM2 ?? 0;
      if (anchorAreaM2 < cfg.bays.minAnchorAreaM2) {
        result.noAnchorArea++;
        return false;
      }
      const helperName = await bayHelperName(tx, c.position, cfg.bays.helperNameMaxDistanceM, cfg.bays.helperNameTypes);
      const [object] = await tx
        .insert(geoObjects)
        .values({ type: "bay", origin: "computed", geom: sql`${geom}` })
        .returning({ id: geoObjects.id });
      await assignParentOf(tx, object!.id);
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
      return true;
    });
    result.duplicates = duplicates;
    return result;
  });
}
