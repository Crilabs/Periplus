import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, places, reviewTasks, tiles, type GeoObjectType } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { STAGES } from "@/lib/jobs/stages";
import { DETECT_BAYS_STAGE, GEOMETRY_STAGE } from "@/lib/pipeline/geometry";
import { withRollback } from "@/test/db";
import { insertTestRaster } from "@/test/geometry/raster";
import { insertScenePlace } from "@/test/geometry/scene";
import { circle, difference, insertLand, lonLatOf, rect, utmOf } from "@/test/geometry/synthetic";
import { bayClusters, bayHelperName, clusterHits, detectTileBays, type BayHit } from "../bays";

const cfg = loadConfig("config").geometry;

/** Centre of the synthetic bay, x metres east of the reference point (inside one tile, ≈ 21.03 E / 35.24 N). */
const BAY_X = 3000;

/**
 * Land north of y = 0 (a straight coast) minus a 500 m circle around (x, 0) (default BAY_X): a half-circle bay open to
 * the south, with the synthetic raster (4–12 m in rows 1–5) under it unless `raster` is false. x = 0 is the tile edge
 * at 21.0 E (the UTM 34 central meridian). Returns the tile of (x, 100). Only inside `withRollback`.
 */
async function bayScene(tx: Db, opts: { bay?: boolean; raster?: boolean; x?: number } = {}): Promise<string> {
  const x = opts.x ?? BAY_X;
  const land = rect(-20000, 0, 20000, 20000);
  await insertLand(tx, [opts.bay === false ? land : await difference(tx, land, await circle(tx, x, 0, 500))]);
  const inBay = await lonLatOf(tx, x, 100);
  const tileId = tileIdFor(inBay.lon, inBay.lat);
  if (opts.raster ?? true) await insertTestRaster(tx, { origin: await lonLatOf(tx, x - 455, 555), tileId });
  return tileId;
}

/** Tile of (x, 100) metres from the reference point. */
async function tileAt(tx: Db, x: number): Promise<string> {
  const p = await lonLatOf(tx, x, 100);
  return tileIdFor(p.lon, p.lat);
}

async function namedObject(tx: Db, x: number, y: number, name: string, type: GeoObjectType = "settlement"): Promise<string> {
  const p = await lonLatOf(tx, x, y);
  const [o] = await tx
    .insert(geoObjects)
    .values({ type, origin: "osm", geom: sql`${geomFromGeoJson({ type: "Point", coordinates: [p.lon, p.lat] })}` })
    .returning({ id: geoObjects.id });
  await tx.insert(geoNames).values({
    geoObjectId: o!.id,
    name,
    nameNormalized: name.toLowerCase(),
    language: "de",
    script: "latin",
    origin: "osm",
  });
  return o!.id;
}

/** Positions (metres from the reference point) of the detected candidate places. */
async function candidatePositions(tx: Db): Promise<{ x: number; y: number }[]> {
  const { rows } = await tx.execute<{ lon: number; lat: number }>(sql`
    select ST_X(p.position) as lon, ST_Y(p.position) as lat
    from places p join geo_objects g on g.id = p.geo_object_id
    where g.origin = 'computed' and p.status = 'candidate'`);
  return Promise.all(rows.map((r) => utmOf(tx, { lon: Number(r.lon), lat: Number(r.lat) })));
}

const hit = (k: number, x: number, y: number, landRays: number): BayHit => ({ k, x, y, landRays, position: { lon: x, lat: y } });

describe("clusterHits", () => {
  it("keeps two groups more than mergeDistanceM apart as two clusters, even within maxClusterSpanM", () => {
    const gap = cfg.bays.mergeDistanceM + 100;
    expect(gap).toBeLessThan(cfg.bays.maxClusterSpanM / 2);
    const clusters = clusterHits([hit(1, 0, 0, 40), hit(2, 50, 0, 38), hit(3, 50 + gap, 0, 39), hit(4, 100 + gap, 0, 37)], cfg.bays);
    expect(clusters.map((c) => [c.position.lon, c.hits])).toEqual([
      [0, 2],
      [50 + gap, 2],
    ]);
  });

  it("merges hits up to mergeDistanceM apart (single linkage) and represents them by the most land rays", () => {
    const step = cfg.bays.mergeDistanceM;
    const clusters = clusterHits([hit(1, 0, 0, 36), hit(2, step, 0, 44), hit(3, 2 * step, 0, 40)], cfg.bays);
    expect(clusters).toEqual([{ position: { lon: step, lat: 0 }, landDeg: 44 * (360 / cfg.bays.rayCount), hits: 3 }]);
  });

  it("cuts a chain longer than maxClusterSpanM into pieces of at most that span, each hit in exactly one", () => {
    const chain = Array.from({ length: 81 }, (_, i) => hit(i, i * 50, 0, 36 + (i % 7)));
    const clusters = clusterHits(chain, cfg.bays);
    expect(clusters.length).toBeGreaterThanOrEqual(Math.ceil(4000 / cfg.bays.maxClusterSpanM));
    expect(clusters.reduce((sum, c) => sum + c.hits, 0)).toBe(chain.length);
    const reps = clusters.map((c) => c.position.lon).sort((a, b) => a - b);
    // representatives lie more than half the span apart; every hit lies within half the span of one
    for (let i = 1; i < reps.length; i++) expect(reps[i]! - reps[i - 1]!).toBeGreaterThan(cfg.bays.maxClusterSpanM / 2);
    for (const h of chain) expect(Math.min(...reps.map((r) => Math.abs(r - h.x)))).toBeLessThanOrEqual(cfg.bays.maxClusterSpanM / 2);
  });
});

describe("bayClusters", () => {
  it("finds the half-circle bay as one cluster with at least 180° of land", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx);
      const found = await bayClusters(tx, tileId, cfg.bays);
      expect(found.samples).toBeGreaterThan(100);
      expect(found.hits).toBeGreaterThan(1);
      expect(found.clusters).toHaveLength(1);
      const [bay] = found.clusters;
      expect(bay!.landDeg).toBeGreaterThanOrEqual(180);
      expect(bay!.hits).toBe(found.hits);
      const { x, y } = await utmOf(tx, bay!.position);
      expect(Math.abs(x - BAY_X)).toBeLessThan(150);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(500);
    }));

  it("a straight coast has probes but no hit (≈ 149° of land at 400 m)", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx, { bay: false });
      const found = await bayClusters(tx, tileId, cfg.bays);
      expect(found.probes).toBeGreaterThan(100);
      expect(found.hits).toBe(0);
      expect(found.clusters).toEqual([]);
    }));

  it("takes only probes inside the tile: a bay just west of the tile edge belongs to the western tile alone", () =>
    withRollback(async (tx) => {
      // circle around x = −450: its arc reaches 50 m into the eastern tile, its probe hits all lie west of x = 0
      await bayScene(tx, { x: -450, raster: false });
      const east = await tileAt(tx, 1);
      const west = await tileAt(tx, -1);
      expect(east).not.toBe(west);
      expect((await bayClusters(tx, east, cfg.bays)).clusters).toEqual([]);
      const { clusters } = await bayClusters(tx, west, cfg.bays);
      expect(clusters).toHaveLength(1);
      expect(tileIdFor(clusters[0]!.position.lon, clusters[0]!.position.lat)).toBe(west);
    }));

  it("gives every representative of a bay on the tile edge inside its own tile", () =>
    withRollback(async (tx) => {
      await bayScene(tx, { x: 0, raster: false });
      for (const tileId of [await tileAt(tx, 1), await tileAt(tx, -1)]) {
        const { clusters } = await bayClusters(tx, tileId, cfg.bays);
        expect(clusters.length).toBeGreaterThan(0);
        for (const c of clusters) expect(tileIdFor(c.position.lon, c.position.lat)).toBe(tileId);
      }
    }));
});

/** Gulf 1.2 km wide and 4 km deep (head at y = 4000) around x = BAY_X, with a cove of radius 300 m on its west wall at y = 2000. */
const COVE = { x: BAY_X - 600, y: 2000, r: 300 };

async function gulfScene(tx: Db): Promise<string> {
  let land = await difference(tx, rect(-20000, 0, 20000, 20000), rect(BAY_X - 600, -10, BAY_X + 600, 4000));
  land = await difference(tx, land, await circle(tx, COVE.x, COVE.y, COVE.r));
  await insertLand(tx, [land]);
  // bathymetry only under the cove and the gulf next to it
  const origin = await lonLatOf(tx, COVE.x - 200, COVE.y + 555);
  const tileId = tileIdFor(origin.lon, origin.lat);
  await insertTestRaster(tx, { origin, tileId });
  return tileId;
}

describe("detectTileBays", () => {
  it("creates a computed bay object without names, a candidate place and a place_candidate task with the helper name", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx);
      await namedObject(tx, BAY_X, 1500, "Testdorf");
      const result = await detectTileBays(tx, tileId, cfg);
      expect(result).toMatchObject({ knownHits: 0, clusters: 1, created: 1, noAnchorArea: 0 });

      const [task] = await tx
        .select()
        .from(reviewTasks)
        .where(sql`${reviewTasks.kind} = 'place_candidate' and ${reviewTasks.context}->>'helperName' is not null`);
      expect(task).toMatchObject({ status: "open", subjectType: "place" });
      const context = task!.context as Record<string, unknown>;
      expect(context).toMatchObject({ name: "Bucht bei Testdorf", helperName: "Bucht bei Testdorf", kind: "anchorage", tileId });
      expect((context.detected as { anchorAreaM2: number }).anchorAreaM2).toBeGreaterThanOrEqual(cfg.bays.minAnchorAreaM2);

      const [place] = await tx.select().from(places).where(eq(places.id, task!.subjectId));
      expect(place).toMatchObject({ status: "candidate", kind: "anchorage", publicId: null, tileId });
      const [object] = await tx.select().from(geoObjects).where(eq(geoObjects.id, place!.geoObjectId));
      expect(object).toMatchObject({ type: "bay", origin: "computed", osmId: null });
      expect(context.geoObjectId).toBe(object!.id);
      // the helper name is display only: never a geo name
      expect(await tx.select().from(geoNames).where(eq(geoNames.geoObjectId, object!.id))).toEqual([]);
    }));

  it("gives the detected bay object its parent by the hierarchy rule (the island around it)", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx);
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into geo_objects (id, type, origin, geom)
        values (${newId()}, 'island', 'osm', ST_Transform(ST_GeomFromText(${rect(-20000, 0, 20000, 20000)}, 32634), 4326))
        returning id`);
      expect((await detectTileBays(tx, tileId, cfg)).created).toBe(1);
      const [object] = await tx.select().from(geoObjects).where(sql`${geoObjects.origin} = 'computed'`);
      expect(object!.parentId).toBe(rows[0]!.id);
    }));

  it("a rerun creates nothing: the detected place makes its hits known", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx);
      const first = await detectTileBays(tx, tileId, cfg);
      expect(first.created).toBe(1);
      expect(await detectTileBays(tx, tileId, cfg)).toMatchObject({ knownHits: first.hits, clusters: 0, created: 0 });
    }));

  it("skips a bay with a place nearby, also a rejected one", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx);
      await insertScenePlace(tx, BAY_X + 200, 200, { status: "rejected" });
      const result = await detectTileBays(tx, tileId, cfg);
      expect(result).toMatchObject({ clusters: 0, created: 0 });
      expect(result.knownHits).toBe(result.hits);
    }));

  it("counts a place 600 m from the bay's hits as not known (knownPlaceDistanceM 500)", () =>
    withRollback(async (tx) => {
      expect(cfg.bays.knownPlaceDistanceM).toBe(500);
      // the hits lie at y ≈ 10 … 100 around x = BAY_X
      const tileId = await bayScene(tx);
      const far = await insertScenePlace(tx, BAY_X, 100 + 600, { status: "rejected" });
      expect(await detectTileBays(tx, tileId, cfg)).toMatchObject({ knownHits: 0, created: 1 });
      expect(far.tileId).toBe(tileId);
    }));

  it("drops every hit within knownPlaceDistanceM of a place 350 m north of the bay's inner hits", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx);
      await insertScenePlace(tx, BAY_X, 100 + 350, { status: "rejected" });
      expect(await detectTileBays(tx, tileId, cfg)).toMatchObject({ clusters: 0, created: 0 });
    }));

  it("skips a bay inside a bay object of the gazetteer", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx);
      const { rows } = await tx.execute<{ wkt: string }>(sql`select ${await circle(tx, BAY_X, 0, 450)} as wkt`);
      await tx.execute(sql`
        insert into geo_objects (id, type, origin, geom)
        values (${newId()}, 'bay', 'osm', ST_Transform(ST_GeomFromText(${rows[0]!.wkt}, 32634), 4326))`);
      expect(await detectTileBays(tx, tileId, cfg)).toMatchObject({ clusters: 0, created: 0 });
    }));

  it("creates nothing without an anchor area (no bathymetry under the bay)", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx, { raster: false });
      expect(await detectTileBays(tx, tileId, cfg)).toMatchObject({ clusters: 1, created: 0, noAnchorArea: 1 });
    }));

  it("proposes the side cove of a gulf whose head is a confirmed place: exactly one candidate in the cove (ruling M7-I-R1)", () =>
    withRollback(async (tx) => {
      const tileId = await gulfScene(tx);
      await insertScenePlace(tx, BAY_X, 3900, { status: "confirmed" });
      const result = await detectTileBays(tx, tileId, cfg);
      expect(result.knownHits).toBeGreaterThan(0);
      const inCove = (await candidatePositions(tx)).filter((p) => Math.hypot(p.x - COVE.x, p.y - COVE.y) < COVE.r);
      expect(inCove).toHaveLength(1);
      // a rerun adds nothing in the cove
      await detectTileBays(tx, tileId, cfg);
      expect((await candidatePositions(tx)).filter((p) => Math.hypot(p.x - COVE.x, p.y - COVE.y) < COVE.r)).toHaveLength(1);
    }));

  for (const westFirst of [true, false]) {
    it(`creates one candidate for a bay on the tile edge, ${westFirst ? "western" : "eastern"} tile first (M-1)`, () =>
      withRollback(async (tx) => {
        await bayScene(tx, { x: 0 });
        const [west, east] = [await tileAt(tx, -1), await tileAt(tx, 1)];
        expect(west).not.toBe(east);
        const order = westFirst ? [west, east] : [east, west];
        const created = [];
        for (const tileId of order) created.push((await detectTileBays(tx, tileId, cfg)).created);
        expect(created).toEqual([1, 0]);
        expect(await candidatePositions(tx)).toHaveLength(1);
      }));
  }

  it("lets the place stage of the run plan the detected candidate (its position lies in the tile)", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx);
      const [w, s, e, n] = tileBbox(tileId);
      await tx
        .insert(tiles)
        .values({ id: tileId, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, hasCoast: true })
        .onConflictDoNothing();
      expect((await detectTileBays(tx, tileId, cfg)).created).toBe(1);
      const [task] = await tx.select().from(reviewTasks).where(sql`${reviewTasks.context}->>'helperName' is not null or ${reviewTasks.context} ? 'detected'`);
      const planned = await STAGES[GEOMETRY_STAGE]!.plan(tx, { id: newId(), params: { tileIds: [tileId] } });
      expect(planned).toContainEqual({ key: task!.subjectId, placeId: task!.subjectId });
    }));
});

describe("bayHelperName", () => {
  it("names the nearest named settlement within the radius, else null", () =>
    withRollback(async (tx) => {
      await bayScene(tx, { raster: false });
      const p = await lonLatOf(tx, BAY_X, 100);
      expect(await bayHelperName(tx, p, 5000, cfg.bays.helperNameTypes)).toBeNull();
      await namedObject(tx, BAY_X, 4000, "Fernort");
      await namedObject(tx, BAY_X + 500, 1200, "Nahort");
      expect(await bayHelperName(tx, p, 5000, cfg.bays.helperNameTypes)).toBe("Bucht bei Nahort");
      expect(await bayHelperName(tx, p, 500, cfg.bays.helperNameTypes)).toBeNull();
    }));

  it("prefers a nearer cape over a settlement, and any of them over a nearer island", () =>
    withRollback(async (tx) => {
      await bayScene(tx, { raster: false });
      const p = await lonLatOf(tx, BAY_X, 100);
      await namedObject(tx, BAY_X, 300, "Inselchen", "island");
      expect(await bayHelperName(tx, p, 5000, cfg.bays.helperNameTypes)).toBe("Bucht bei Inselchen");
      await namedObject(tx, BAY_X, 2000, "Dorf");
      expect(await bayHelperName(tx, p, 5000, cfg.bays.helperNameTypes)).toBe("Bucht bei Dorf");
      await namedObject(tx, BAY_X, 1000, "Kap", "cape");
      expect(await bayHelperName(tx, p, 5000, cfg.bays.helperNameTypes)).toBe("Bucht bei Kap");
    }));
});

describe("stage geometry.detect_bays", () => {
  it("plans one job per tile, none for a place run", () =>
    withRollback(async (tx) => {
      const stage = STAGES[DETECT_BAYS_STAGE]!;
      expect(stage.queue).toBe("geometry.detect_bays");
      const tileId = await bayScene(tx, { raster: false });
      expect(await stage.plan(tx, { id: newId(), params: { tileIds: [tileId] } })).toEqual([{ key: tileId, tileId }]);
      expect(await stage.plan(tx, { id: newId(), params: { placeIds: [newId()] } })).toEqual([]);
    }));
});
