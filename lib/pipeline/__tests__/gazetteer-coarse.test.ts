import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeResponse, type Transport } from "@/lib/adapters/http";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import type { Db } from "@/lib/db/client";
import { subdivisions } from "@/lib/db/schema";
import { getConfig } from "@/lib/config";
import { newPublicId } from "@/lib/domain/ids";
import { applySubdivisionPlan } from "@/lib/domain/subdivisions/store";
import { importCoarseFeatures } from "@/lib/pipeline/gazetteer/coarse";
import { withRollback } from "@/test/db";

// The bucket "http:overpass" is shared across test files; a huge rate keeps these tests (a mock of `takeToken` does not reach http.ts, which the setup loads first) from ever sleeping on it.
const overpass = { ...getConfig().gazetteer.overpass, ratePerMinute: 1_000_000 };

/**
 * A synthetic MT country polygon (not the real relation: its unique osm_id would make parallel test files wait for each
 * other) and land at Malta's longitudes with its east edge 2 km east of Valletta: Valletta lies at the coast, inland
 * towns do not.
 */
async function setUpMalta(tx: Db): Promise<string> {
  const inserted = await tx.execute<{ id: string }>(sql`INSERT INTO geo_objects (id, type, origin, admin_level, tags, geom)
    VALUES (gen_random_uuid(), 'country', 'osm', 2, '{"country":"MT","ISO3166-1":"MT"}'::jsonb,
            ST_Multi(ST_GeomFromText('POLYGON((14.0 35.7, 15.1 35.7, 15.1 36.2, 14.0 36.2, 14.0 35.7))', 4326))) RETURNING id`);
  await tx.execute(sql`INSERT INTO land_polygons (id, geom, dataset_version)
    VALUES (gen_random_uuid(), ST_GeomFromText('POLYGON((14.15 35.8, 14.53 35.8, 14.53 36.1, 14.15 36.1, 14.15 35.8))', 4326), 'test')`);
  const country = { id: inserted.rows[0]!.id };
  await applySubdivisionPlan(
    tx,
    [{ key: "MT-T", country: "MT", geoObjectId: country.id, memberGeoObjectIds: [country.id], cutGeoObjectIds: [], adminLevel: 2, status: "active", statusReason: null, names: {} }],
    "2026-10-21",
  );
  return country.id;
}

async function malta(tx: Db, name: string, type?: string) {
  const { rows } = await tx.execute<{ id: string; type: string; subdivision_id: string | null; osm_id: string; updated_at: string }>(sql`
    SELECT DISTINCT o.id, o.type, o.subdivision_id, o.osm_id, o.updated_at FROM geo_objects o
    JOIN geo_names n ON n.geo_object_id = o.id
    WHERE o.valid_to IS NULL AND o.origin = 'osm' AND o.osm_id IS NOT NULL AND n.name = ${name}
      AND o.type NOT IN ('country', 'admin_region')`);
  return type ? rows.filter((r) => r.type === type) : rows;
}

const ring = (w: number, s: number, e: number, n: number) => [
  { lat: s, lon: w }, { lat: s, lon: e }, { lat: n, lon: e }, { lat: n, lon: w }, { lat: s, lon: w },
];

describe("importCoarseFeatures", () => {
  it("MT: Malta, Gozo, Comino, the archipelago and Valletta, with the Malta subdivision; a second import changes nothing", async () => {
    await withRollback(async (tx) => {
      await setUpMalta(tx);
      const [sd] = await tx.select({ id: subdivisions.id }).from(subdivisions).where(and(eq(subdivisions.key, "MT-T"), isNull(subdivisions.validTo)));
      const result = await importCoarseFeatures(tx, "MT", { transport: fixtureTransport(), overpass });
      expect(result).toEqual({ islands: 3, archipelagos: 1, gulfs: 0, towns: 20 });

      for (const [name, type] of [["Malta", "island"], ["Għawdex", "island"], ["Kemmuna", "island"], ["Il-Gżejjer Maltin", "archipelago"], ["Valletta", "settlement"]] as const) {
        const rows = await malta(tx, name, type);
        expect(rows, name).toHaveLength(1);
        expect(rows[0]).toMatchObject({ type, subdivision_id: sd!.id });
      }
      // relation/20354542 "MALTA" is a place=island multipolygon of two rings of 6 and 7 points (a few metres wide):
      // below islandMinAreaKm2, so it stays with the fine gazetteer.
      const { rows: tiny } = await tx.execute(sql`SELECT 1 FROM geo_objects WHERE osm_id = 'relation/20354542'`);
      expect(tiny).toHaveLength(0);
      const [gozo] = await malta(tx, "Għawdex");
      const { rows: names } = await tx.execute<{ name: string }>(sql`SELECT name FROM geo_names WHERE geo_object_id = ${gozo!.id}`);
      expect(names.map((n) => n.name)).toContain("Gozo");
      const { rows: before } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM geo_objects WHERE origin = 'osm'`);
      const snapshot = await tx.execute(sql`SELECT id, updated_at, parent_id, subdivision_id FROM geo_objects WHERE origin = 'osm' ORDER BY id`);

      expect(await importCoarseFeatures(tx, "MT", { transport: fixtureTransport(), overpass })).toEqual(result);
      const { rows: after } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM geo_objects WHERE origin = 'osm'`);
      expect(after[0]!.n).toBe(before[0]!.n);
      expect((await tx.execute(sql`SELECT id, updated_at, parent_id, subdivision_id FROM geo_objects WHERE origin = 'osm' ORDER BY id`)).rows).toEqual(snapshot.rows);
    }, { isolationLevel: "repeatable read" }); // one snapshot: rows other files commit meanwhile must not show in the before/after comparison
  }, 120_000);

  it("keeps a large bay as gulf; drops a small island, a small bay and a town away from the coast", async () => {
    const element = (type: "way" | "node", id: number, tags: Record<string, string>, geometry?: ReturnType<typeof ring>, at?: [number, number]) =>
      geometry ? { type, id, tags, geometry } : { type, id, tags, lat: at![0], lon: at![1] };
    const elements = [
      element("way", 9_100_001, { natural: "bay", name: "Great Test Bay" }, ring(14.7, 35.8, 15.0, 36.0)),
      element("way", 9_100_002, { natural: "bay", name: "Tiny Test Bay" }, ring(14.7, 35.7, 14.71, 35.71)),
      element("way", 9_100_003, { place: "island", name: "Test Rock" }, ring(14.7, 35.5, 14.701, 35.501)),
      element("way", 9_100_004, { place: "island", name: "Test Island" }, ring(14.7, 35.4, 14.75, 35.45)),
      element("node", 9_100_005, { place: "town", name: "Inland Test Town" }, undefined, [35.95, 14.3]),
    ];
    const transport: Transport = async () => makeResponse(200, new TextEncoder().encode(JSON.stringify({ elements })));
    await withRollback(async (tx) => {
      await setUpMalta(tx);
      expect(await importCoarseFeatures(tx, "MT", { transport, overpass })).toEqual({ islands: 1, archipelagos: 0, gulfs: 1, towns: 0 });
      expect(await malta(tx, "Great Test Bay")).toMatchObject([{ type: "gulf" }]);
      expect(await malta(tx, "Test Island")).toMatchObject([{ type: "island" }]);
      for (const n of ["Tiny Test Bay", "Test Rock", "Inland Test Town"]) expect(await malta(tx, n), n).toHaveLength(0);
    });
  }, 120_000);

  it("updates a feature the fine gazetteer imported instead of duplicating it", async () => {
    await withRollback(async (tx) => {
      await setUpMalta(tx);
      const publicId = newPublicId("rg");
      await tx.execute(sql`INSERT INTO geo_objects (id, type, origin, osm_id, public_id, tags, geom)
        VALUES (gen_random_uuid(), 'island', 'osm', 'relation/9353903', ${publicId}, '{}'::jsonb,
                ST_Multi(ST_GeomFromText('POLYGON((14.2 36.0, 14.3 36.0, 14.3 36.1, 14.2 36.0))', 4326)))
        ON CONFLICT DO NOTHING`);
      await importCoarseFeatures(tx, "MT", { transport: fixtureTransport(), overpass });
      const { rows } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM geo_objects WHERE osm_id = 'relation/9353903' AND valid_to IS NULL`);
      expect(rows[0]!.n).toBe(1);
      const { rows: ids } = await tx.execute<{ public_id: string }>(sql`SELECT public_id FROM geo_objects WHERE osm_id = 'relation/9353903' AND valid_to IS NULL`);
      expect(ids[0]!.public_id).toBe(publicId);
      expect(await malta(tx, "Għawdex", "island")).toHaveLength(1);
    });
  }, 120_000);

  it("fails before any query when the country is not stored", async () => {
    await withRollback(async (tx) => {
      await expect(importCoarseFeatures(tx, "MT", { transport: fixtureTransport(), overpass })).rejects.toThrow(/no country object/);
    });
  });
});
