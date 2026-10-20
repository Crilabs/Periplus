import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, places, reviewTasks } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { tileIdFor } from "@/lib/domain/tiles";
import { STAGES } from "@/lib/jobs/stages";
import { DETECT_BAYS_STAGE } from "@/lib/pipeline/geometry";
import { withRollback } from "@/test/db";
import { insertTestRaster } from "@/test/geometry/raster";
import { insertScenePlace } from "@/test/geometry/scene";
import { circle, difference, insertLand, lonLatOf, rect, utmOf } from "@/test/geometry/synthetic";
import { bayClusters, bayHelperName, detectTileBays } from "../bays";

const cfg = loadConfig("config").geometry;

/** Centre of the synthetic bay, x metres east of the reference point (inside one tile, ≈ 21.03 E / 35.24 N). */
const BAY_X = 3000;

/**
 * Land north of y = 0 (a straight coast) minus a 500 m circle around (BAY_X, 0): a half-circle bay open to the south,
 * with the synthetic raster (4–12 m in rows 1–5) under it unless `raster` is false. Only inside `withRollback`.
 */
async function bayScene(tx: Db, opts: { bay?: boolean; raster?: boolean } = {}): Promise<string> {
  const land = rect(-20000, 0, 20000, 20000);
  await insertLand(tx, [opts.bay === false ? land : await difference(tx, land, await circle(tx, BAY_X, 0, 500))]);
  const inBay = await lonLatOf(tx, BAY_X, 100);
  const tileId = tileIdFor(inBay.lon, inBay.lat);
  if (opts.raster ?? true) await insertTestRaster(tx, { origin: await lonLatOf(tx, BAY_X - 455, 555), tileId });
  return tileId;
}

async function namedSettlement(tx: Db, x: number, y: number, name: string): Promise<string> {
  const p = await lonLatOf(tx, x, y);
  const [o] = await tx
    .insert(geoObjects)
    .values({ type: "settlement", origin: "osm", geom: sql`${geomFromGeoJson({ type: "Point", coordinates: [p.lon, p.lat] })}` })
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
});

describe("detectTileBays", () => {
  it("creates a computed bay object without names, a candidate place and a place_candidate task with the helper name", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx);
      await namedSettlement(tx, BAY_X, 1500, "Testdorf");
      const result = await detectTileBays(tx, tileId, cfg);
      expect(result).toMatchObject({ clusters: 1, created: 1, known: 0, noAnchorArea: 0 });

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

  it("a rerun creates nothing: the detected place is known", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx);
      expect((await detectTileBays(tx, tileId, cfg)).created).toBe(1);
      expect(await detectTileBays(tx, tileId, cfg)).toMatchObject({ clusters: 1, created: 0, known: 1 });
    }));

  it("skips a bay with a place nearby, also a rejected one", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx);
      await insertScenePlace(tx, BAY_X + 200, 200, { status: "rejected" });
      expect(await detectTileBays(tx, tileId, cfg)).toMatchObject({ clusters: 1, created: 0, known: 1 });
    }));

  it("skips a bay inside a bay object of the gazetteer", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx);
      const { rows } = await tx.execute<{ wkt: string }>(sql`select ${await circle(tx, BAY_X, 0, 450)} as wkt`);
      await tx.execute(sql`
        insert into geo_objects (id, type, origin, geom)
        values (${newId()}, 'bay', 'osm', ST_Transform(ST_GeomFromText(${rows[0]!.wkt}, 32634), 4326))`);
      expect(await detectTileBays(tx, tileId, cfg)).toMatchObject({ clusters: 1, created: 0, known: 1 });
    }));

  it("creates nothing without an anchor area (no bathymetry under the bay)", () =>
    withRollback(async (tx) => {
      const tileId = await bayScene(tx, { raster: false });
      expect(await detectTileBays(tx, tileId, cfg)).toMatchObject({ clusters: 1, created: 0, noAnchorArea: 1 });
    }));
});

describe("bayHelperName", () => {
  it("names the nearest named settlement within the radius, else null", () =>
    withRollback(async (tx) => {
      await bayScene(tx, { raster: false });
      const p = await lonLatOf(tx, BAY_X, 100);
      expect(await bayHelperName(tx, p, 5000)).toBeNull();
      await namedSettlement(tx, BAY_X, 4000, "Fernort");
      await namedSettlement(tx, BAY_X + 500, 1200, "Nahort");
      expect(await bayHelperName(tx, p, 5000)).toBe("Bucht bei Nahort");
      expect(await bayHelperName(tx, p, 500)).toBeNull();
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
