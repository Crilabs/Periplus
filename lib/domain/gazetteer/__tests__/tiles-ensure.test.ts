import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, landPolygons, subdivisions, tiles } from "@/lib/db/schema";
import { newPublicId } from "@/lib/domain/ids";
import { tileIdFor } from "@/lib/domain/tiles";

/** A synthetic subdivision: polygon and land are boxes [west, south, east, north]; outside the pilot box. */
async function addSubdivision(
  db: Db,
  key: string,
  box: [number, number, number, number],
  landBox: [number, number, number, number] | null,
  patch: Partial<typeof subdivisions.$inferInsert> = {},
): Promise<string> {
  const env = (b: [number, number, number, number]) => sql`ST_Multi(ST_MakeEnvelope(${b[0]}, ${b[1]}, ${b[2]}, ${b[3]}, 4326))`;
  const [obj] = await db
    .insert(geoObjects)
    .values({ type: "admin_region", origin: "manual", configKey: key, geom: env(box) })
    .returning({ id: geoObjects.id });
  const [row] = await db
    .insert(subdivisions)
    .values({
      publicId: newPublicId("sd"),
      key,
      country: "GR",
      geoObjectId: obj!.id,
      geom: env(box),
      landGeom: landBox ? env(landBox) : null,
      ...patch,
    })
    .returning({ id: subdivisions.id });
  return row!.id;
}

async function addLand(db: Db, w: number, s: number, e: number, n: number) {
  await db.insert(landPolygons).values({ geom: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, datasetVersion: "test" });
}
import { ensureSubdivisionTiles, subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { withRollback } from "@/test/db";

const SHARED = tileIdFor(26.3, 35.1); // 26.25-26.5 x 35.0-35.25
const A_ONLY = tileIdFor(26.1, 35.1);

async function tile(db: Db, id: string) {
  const [row] = await db.select().from(tiles).where(eq(tiles.id, id));
  return row;
}

/** A (west, polygon 26.0-26.4) and B (east, 26.3-26.75) share the tile 26.25-26.5; B has more land in it. */
async function setup(db: Db) {
  await addLand(db, 26.0, 35.05, 26.45, 35.2);
  const a = await addSubdivision(db, "XA-A", [26.0, 35.0, 26.4, 35.25], [26.0, 35.05, 26.3, 35.2]);
  const b = await addSubdivision(db, "XA-B", [26.3, 35.0, 26.75, 35.25], [26.3, 35.05, 26.45, 35.2]);
  return { a, b };
}

describe("ensureSubdivisionTiles", () => {
  it("shared border tile is in both subdivision scopes", () =>
    withRollback(async (db) => {
      const { a, b } = await setup(db);
      expect(await ensureSubdivisionTiles(db, a)).toEqual({ tiles: 2, coast: 2 });
      expect(await ensureSubdivisionTiles(db, b)).toEqual({ tiles: 2, coast: 1 });
      expect(await subdivisionTileIds(db, a)).toEqual([A_ONLY, SHARED].sort());
      expect(await subdivisionTileIds(db, b)).toEqual([SHARED]);
    }));

  it("label goes to the subdivision with more coastline in the tile", () =>
    withRollback(async (db) => {
      const { a, b } = await setup(db);
      await ensureSubdivisionTiles(db, a);
      expect((await tile(db, SHARED))!.subdivisionId).toBe(b);
      expect((await tile(db, A_ONLY))!.subdivisionId).toBe(a);
      await ensureSubdivisionTiles(db, b);
      expect((await tile(db, SHARED))!.subdivisionId).toBe(b);
      expect((await tile(db, SHARED))!.areaId).toBeNull();
    }));

  it("excluded subdivision creates no tiles", () =>
    withRollback(async (db) => {
      await addLand(db, 26.0, 35.05, 26.45, 35.2);
      const x = await addSubdivision(db, "XA-X", [26.0, 35.0, 26.4, 35.25], [26.0, 35.05, 26.3, 35.2], {
        status: "excluded",
        statusReason: "test",
      });
      await expect(ensureSubdivisionTiles(db, x)).rejects.toThrow("Landesteil XA-X ist ausgeschlossen");
      expect(await tile(db, A_ONLY)).toBeUndefined();
    }));

  it("cycle_days from country, override per key wins", () =>
    withRollback(async (db) => {
      const { a, b } = await setup(db);
      const overrides = getConfig().subdivisions.overrides;
      overrides["XA-B"] = { cycleDays: 7 };
      try {
        await ensureSubdivisionTiles(db, a);
        await ensureSubdivisionTiles(db, b);
        const [bOnly] = [await tile(db, tileIdFor(26.6, 35.1))];
        expect(bOnly!.cycleDays).toBe(7);
        expect((await tile(db, A_ONLY))!.cycleDays).toBe(getConfig().subdivisions.countries.GR!.cycleDays);
      } finally {
        delete overrides["XA-B"];
      }
    }));

  it("second run changes nothing and writes no history", () =>
    withRollback(async (db) => {
      const { a } = await setup(db);
      await ensureSubdivisionTiles(db, a);
      await ensureSubdivisionTiles(db, a);
      const [{ h }] = await db
        .execute<{ h: number }>(sql`SELECT count(*)::int AS h FROM tiles_history WHERE row_id = ANY(${`{${A_ONLY},${SHARED}}`}::text[])`)
        .then((x) => x.rows);
      expect(h).toBe(0);
    }));

  it("a subdivision without land polygons has tiles but no coast", () =>
    withRollback(async (db) => {
      const a = await addSubdivision(db, "XA-N", [26.0, 35.0, 26.2, 35.2], null);
      expect(await ensureSubdivisionTiles(db, a)).toEqual({ tiles: 1, coast: 0 });
      expect(await subdivisionTileIds(db, a)).toEqual([]);
    }));
});
