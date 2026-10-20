import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geoObjects, landPolygons, subdivisions } from "@/lib/db/schema";
import { ensureSubdivisionTiles } from "@/lib/domain/gazetteer/tiles-ensure";
import { newPublicId } from "@/lib/domain/ids";
import { tileIdFor } from "@/lib/domain/tiles";
import { seedTileIds } from "@/lib/pipeline/tile-scope";
import { withRollback } from "@/test/db";

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

describe("seedTileIds", () => {
  it("subdivisionKey gives the coast tiles meeting the polygon", () =>
    withRollback(async (db) => {
      await addLand(db, 26.0, 35.05, 26.45, 35.2);
      const a = await addSubdivision(db, "XA-A", [26.0, 35.0, 26.4, 35.25], [26.0, 35.05, 26.3, 35.2]);
      await ensureSubdivisionTiles(db, a);
      expect(await seedTileIds(db, { subdivisionKey: "XA-A" })).toEqual([tileIdFor(26.1, 35.1), tileIdFor(26.3, 35.1)].sort());
    }));

  it("tileIds are returned as given", async () => {
    await withRollback(async (db) => {
      expect(await seedTileIds(db, { tileIds: [tileIdFor(26.1, 35.1)] })).toEqual([tileIdFor(26.1, 35.1)]);
    });
  });

  it("seedTileIds with areaKey names the replacement", () =>
    withRollback(async (db) => {
      await expect(seedTileIds(db, { areaKey: "saronic" })).rejects.toThrow(
        "Revier-Schlüssel saronic ist kein Laufumfang mehr; Landesteil angeben (z. B. GR-I)",
      );
    }));

  it("unknown subdivision and missing params fail clearly", () =>
    withRollback(async (db) => {
      await expect(seedTileIds(db, { subdivisionKey: "XA-NOPE" })).rejects.toThrow("Unbekannter Landesteil XA-NOPE");
      await expect(seedTileIds(db, {})).rejects.toThrow("tileIds or subdivisionKey is required");
    }));
});
