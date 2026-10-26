import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { RetryableHttpError, makeResponse, type Transport } from "@/lib/adapters/http";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import type { Db } from "@/lib/db/client";
import { subdivisions } from "@/lib/db/schema";
import { getConfig } from "@/lib/config";
import { clipBbox, mediterraneanBbox } from "@/lib/domain/gazetteer/land";
import { newPublicId } from "@/lib/domain/ids";
import { applySubdivisionPlan } from "@/lib/domain/subdivisions/store";
import { gazetteerCoarseStage, gazetteerSeasStage } from "@/lib/jobs/handlers/subdivisions";
import { importCoarseFeatures } from "@/lib/pipeline/gazetteer/coarse";
import { assignCoarse } from "@/lib/pipeline/subdivisions";
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
  const { rows } = await tx.execute<{ id: string; type: string; subdivision_id: string | null; sea_id: string | null; osm_id: string; updated_at: string }>(sql`
    SELECT DISTINCT o.id, o.type, o.subdivision_id, o.sea_id, o.osm_id, o.updated_at FROM geo_objects o
    JOIN geo_names n ON n.geo_object_id = o.id
    WHERE o.valid_to IS NULL AND o.origin = 'osm' AND o.osm_id IS NOT NULL AND n.name = ${name}
      AND o.type NOT IN ('country', 'admin_region')`);
  return type ? rows.filter((r) => r.type === type) : rows;
}

const ring = (w: number, s: number, e: number, n: number) => [
  { lat: s, lon: w }, { lat: s, lon: e }, { lat: n, lon: e }, { lat: n, lon: w }, { lat: s, lon: w },
];

describe("importCoarseFeatures", () => {
  it("MT: Malta, Gozo, Comino, the archipelago and Valletta, without subdivision or sea until assignCoarse; a second import changes nothing", async () => {
    await withRollback(async (tx) => {
      await setUpMalta(tx);
      const [sd] = await tx.select({ id: subdivisions.id }).from(subdivisions).where(and(eq(subdivisions.key, "MT-T"), isNull(subdivisions.validTo)));
      const sea = await tx.execute<{ id: string }>(sql`INSERT INTO geo_objects (id, type, origin, tags, geom)
        VALUES (gen_random_uuid(), 'sea', 'marine_regions', ${JSON.stringify({ mrgid: String(getConfig().subdivisions.mediterranean.marineRegionsMrgids[0]) })}::jsonb,
                ST_Multi(ST_GeomFromText('POLYGON((13.5 35.0, 15.5 35.0, 15.5 36.5, 13.5 36.5, 13.5 35.0))', 4326))) RETURNING id`);
      const result = await importCoarseFeatures(tx, "MT", { transport: fixtureTransport(), overpass });
      expect(result).toEqual({ islands: 3, archipelagos: 1, gulfs: 0, towns: 20, splits: 0, blocksSkipped: 0, skippedLarge: 0 });

      const features = [["Malta", "island"], ["Għawdex", "island"], ["Kemmuna", "island"], ["Il-Gżejjer Maltin", "archipelago"], ["Valletta", "settlement"]] as const;
      for (const [name, type] of features) {
        const rows = await malta(tx, name, type);
        expect(rows, name).toHaveLength(1);
        // The assignment is a stage of its own after subdivisions.build (B3, B14).
        expect(rows[0]).toMatchObject({ type, subdivision_id: null, sea_id: null });
      }
      // relation/20354542 "MALTA" is a place=island multipolygon of two rings of 6 and 7 points (a few metres wide):
      // below islandMinAreaKm2, so it stays with the fine gazetteer.
      const { rows: tiny } = await tx.execute(sql`SELECT 1 FROM geo_objects WHERE osm_id = 'relation/20354542'`);
      expect(tiny).toHaveLength(0);
      const [gozo] = await malta(tx, "Għawdex");
      const { rows: names } = await tx.execute<{ name: string }>(sql`SELECT name FROM geo_names WHERE geo_object_id = ${gozo!.id}`);
      expect(names.map((n) => n.name)).toContain("Gozo");
      // Only the rows of the Malta box: rows other test files commit meanwhile must not show in the comparison.
      const maltaRows = () =>
        tx.execute(sql`SELECT id, updated_at, parent_id, subdivision_id FROM geo_objects
          WHERE origin = 'osm' AND geom && ST_MakeEnvelope(14.0, 35.7, 15.1, 36.2, 4326) ORDER BY id`);
      const snapshot = await maltaRows();
      expect(snapshot.rows.length).toBeGreaterThan(0);

      expect(await importCoarseFeatures(tx, "MT", { transport: fixtureTransport(), overpass })).toEqual(result);
      expect((await maltaRows()).rows).toEqual(snapshot.rows);

      await assignCoarse(tx, "MT");
      for (const [name, type] of features) {
        expect((await malta(tx, name, type))[0], name).toMatchObject({ subdivision_id: sd!.id, sea_id: sea.rows[0]!.id });
      }
    });
  }, 120_000);

  /**
   * Answers every query with `elements`, except those `fails` picks (HTTP 502). Records the decoded bodies. With
   * `retries: 0` a 502 fails the part at once; blocks of 0.5 degrees cut the 1.1 x 0.5 MT polygon into 3 x 1.
   */
  const splitting = (fails: (ql: string) => boolean, elements: unknown[] = []) => {
    const bodies: string[] = [];
    const transport: Transport = async (req) => {
      const ql = decodeURIComponent(String(req.body));
      bodies.push(ql);
      return fails(ql) ? makeResponse(502, new TextEncoder().encode("busy")) : makeResponse(200, new TextEncoder().encode(JSON.stringify({ elements })));
    };
    return { bodies, transport };
  };
  const adaptive = { ...overpass, retries: 0, blockDeg: 0.5, minBlockDeg: 0.25 };
  const isIslands = (ql: string) => ql.includes("island");
  // every query carries a box: the country's part of the Mediterranean box (for MT its own box) or a block of it
  const whole = (ql: string) => ql.includes("(area.c)(35.7,14,36.2,15.1)");
  const boxed = (ql: string) => ql.includes("(area.c)(") && !whole(ql);

  it("asks each kind once for the whole country when all answer (B15)", async () => {
    const { bodies, transport } = splitting(() => false);
    await withRollback(async (tx) => {
      await setUpMalta(tx);
      const result = await importCoarseFeatures(tx, "MT", { transport, overpass: adaptive });
      expect(bodies).toHaveLength(3);
      expect(bodies.some(boxed)).toBe(false);
      expect(bodies.every(whole)).toBe(true);
      expect(result).toMatchObject({ splits: 0, blocksSkipped: 0, skippedLarge: 0 });
    });
  }, 120_000);

  /** A synthetic country polygon of `country` (no osm_id, see `setUpMalta`). */
  const insertCountry = (tx: Db, country: string, [w, s, e, n]: [number, number, number, number]) =>
    tx.execute(sql`INSERT INTO geo_objects (id, type, origin, admin_level, tags, geom)
      VALUES (gen_random_uuid(), 'country', 'osm', 2, ${JSON.stringify({ country, "ISO3166-1": country })}::jsonb,
              ST_Multi(ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)))`);

  // GB is configured for Akrotiri and Dhekelia (an `extra` relation), but its country object is the United Kingdom:
  // the whole-country queries fetched every British island and town, and the land check over its box (no land
  // polygons there) failed the job three times (N7 check).
  it("asks nothing for a country whose box lies outside the Mediterranean box (GB) and does not fail the land check", async () => {
    const { bodies, transport } = splitting(() => false);
    await withRollback(async (tx) => {
      await insertCountry(tx, "GB", [-6, 50, 2, 59]);
      const result = await importCoarseFeatures(tx, "GB", { transport, overpass: adaptive });
      expect(bodies).toHaveLength(0);
      expect(result).toEqual({ islands: 0, archipelagos: 0, gulfs: 0, towns: 0, splits: 0, blocksSkipped: 0, skippedLarge: 0 });
    });
  }, 120_000);

  // Spain's whole-country queries fetched the Canaries, the Galician rías and the Bay of Biscay (225,000 points), and
  // the nearest-land rule hung the Atlantic gulfs on Mediterranean subdivisions (N7 check).
  it("asks only the Mediterranean part of a country whose box reaches beyond it (ES), per block after a failure", async () => {
    const bbox: [number, number, number, number] = [-10, 35, 4, 44];
    const [w, s, e, n] = clipBbox(bbox, mediterraneanBbox(getConfig().gazetteer.landBufferKm))!;
    expect(w).toBeGreaterThan(bbox[0]);
    const top = `(area.c)(${s},${w},${n},${e})`;
    const { bodies, transport } = splitting((ql) => isIslands(ql) && ql.includes(top));
    await withRollback(async (tx) => {
      await insertCountry(tx, "ES", bbox);
      const result = await importCoarseFeatures(tx, "ES", { transport, overpass: { ...adaptive, blockDeg: 4 } });
      expect(bodies.filter((ql) => !isIslands(ql)).every((ql) => ql.includes(top))).toBe(true);
      // the failed islands query is asked again per 4-degree block of the clipped box, none west of it
      const blocks = bodies.filter((ql) => isIslands(ql) && !ql.includes(top));
      expect(blocks.length).toBeGreaterThan(1);
      expect(blocks.every((ql) => !ql.includes(`,${bbox[0]},`))).toBe(true);
      expect(result).toMatchObject({ splits: 1 });
    });
  }, 120_000);

  it("asks a kind that fails for the whole country again per block, the other kinds not", async () => {
    const { bodies, transport } = splitting((ql) => isIslands(ql) && !boxed(ql));
    await withRollback(async (tx) => {
      await setUpMalta(tx);
      const result = await importCoarseFeatures(tx, "MT", { transport, overpass: adaptive });
      expect(bodies.filter((ql) => isIslands(ql) && boxed(ql))).toHaveLength(3);
      expect(bodies.filter((ql) => !isIslands(ql))).toHaveLength(2);
      expect(bodies.filter((ql) => !isIslands(ql)).some(boxed)).toBe(false);
      expect(result).toMatchObject({ splits: 1 });
    });
  }, 120_000);

  it("splits a block that keeps failing into its quadrants", async () => {
    const { bodies, transport } = splitting((ql) => isIslands(ql) && (!boxed(ql) || ql.includes("(area.c)(35.7,14,36.2,14.5)")));
    await withRollback(async (tx) => {
      await setUpMalta(tx);
      const result = await importCoarseFeatures(tx, "MT", { transport, overpass: adaptive });
      expect(bodies.filter(isIslands)).toHaveLength(1 + 3 + 4);
      expect(bodies.some((ql) => ql.includes("(area.c)(35.7,14,35.95,14.25)"))).toBe(true);
      expect(bodies.some((ql) => ql.includes("(area.c)(35.95,14.25,36.2,14.5)"))).toBe(true);
      expect(result).toMatchObject({ splits: 2 });
    });
  }, 120_000);

  it("fails the country, naming the part, when a block below overpass.minBlockDeg still fails", async () => {
    const { transport } = splitting(isIslands);
    await withRollback(async (tx) => {
      await setUpMalta(tx);
      const error: unknown = await importCoarseFeatures(tx, "MT", { transport, overpass: adaptive }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RetryableHttpError);
      expect((error as Error).message).toMatch(/overpass part islands#b0\.q0 failed and is not split below overpass\.minBlockDeg/);
    });
  }, 120_000);

  it("never splits an error that is not retryable", async () => {
    const bodies: string[] = [];
    const transport: Transport = async (req) => {
      bodies.push(decodeURIComponent(String(req.body)));
      return makeResponse(400, new TextEncoder().encode("bad query"));
    };
    await withRollback(async (tx) => {
      await setUpMalta(tx);
      const error: unknown = await importCoarseFeatures(tx, "MT", { transport, overpass: adaptive }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RetryableHttpError);
      expect(bodies).toHaveLength(1);
    });
  }, 120_000);

  it("counts an element that lies in two blocks once", async () => {
    const elements = [{ type: "way", id: 9_100_010, tags: { place: "island", name: "Border Island" }, geometry: ring(14.4, 35.9, 14.6, 36.0) }];
    const { transport } = splitting((ql) => isIslands(ql) && !boxed(ql), elements);
    await withRollback(async (tx) => {
      await setUpMalta(tx);
      const result = await importCoarseFeatures(tx, "MT", { transport, overpass: adaptive });
      expect(result).toEqual({ islands: 1, archipelagos: 0, gulfs: 0, towns: 0, splits: 1, blocksSkipped: 0, skippedLarge: 0 });
    });
  }, 120_000);

  it("asks no block that misses the country polygon", async () => {
    // the top query of the widened country carries the widened box
    const top = "(area.c)(35.7,14,36.2,17)";
    const { bodies, transport } = splitting((ql) => isIslands(ql) && ql.includes(top));
    await withRollback(async (tx) => {
      await setUpMalta(tx);
      // A far-off second piece widens the box to 14.0–17.0: of its six 0.5-degree blocks, 15.5–16.0 and 16.0–16.5 lie
      // in neither piece.
      await tx.execute(sql`INSERT INTO geo_objects (id, type, origin, admin_level, tags, geom)
        VALUES (gen_random_uuid(), 'country', 'osm', 2, '{"country":"MT","ISO3166-1":"MT"}'::jsonb,
                ST_Multi(ST_GeomFromText('POLYGON((16.8 35.8, 17.0 35.8, 17.0 35.9, 16.8 35.9, 16.8 35.8))', 4326)))`);
      const result = await importCoarseFeatures(tx, "MT", { transport, overpass: adaptive });
      expect(bodies.filter((ql) => isIslands(ql) && !ql.includes(top))).toHaveLength(4);
      expect(bodies.some((b) => b.includes(",15.5,") || b.includes(",16,"))).toBe(false);
      expect(result).toMatchObject({ splits: 1, blocksSkipped: 2 });
    });
  }, 120_000);

  it("fails loudly when the country object is no polygon", async () => {
    const { bodies, transport } = splitting(() => false);
    await withRollback(async (tx) => {
      await tx.execute(sql`INSERT INTO geo_objects (id, type, origin, admin_level, tags, geom)
        VALUES (gen_random_uuid(), 'country', 'osm', 2, '{"country":"MT","ISO3166-1":"MT"}'::jsonb, ST_SetSRID(ST_MakePoint(14.5, 35.9), 4326))`);
      await expect(importCoarseFeatures(tx, "MT", { transport, overpass: adaptive })).rejects.toThrow(/country object is no polygon \(ST_Point\)/);
      expect(bodies).toHaveLength(0);
    });
  }, 120_000);

  it("keeps a large bay as bay; drops a small island, a small bay and a town away from the coast", async () => {
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
      expect(await importCoarseFeatures(tx, "MT", { transport, overpass })).toEqual({ islands: 1, archipelagos: 0, gulfs: 1, towns: 0, splits: 0, blocksSkipped: 0, skippedLarge: 0 });
      expect(await malta(tx, "Great Test Bay")).toMatchObject([{ type: "bay" }]);
      expect(await malta(tx, "Test Island")).toMatchObject([{ type: "island" }]);
      for (const n of ["Tiny Test Bay", "Test Rock", "Inland Test Town"]) expect(await malta(tx, n), n).toHaveLength(0);
    });
  }, 120_000);

  it("skips a relation with more member points than overpass.maxRelationPoints and counts it in skippedLarge", async () => {
    const limited = { ...overpass, maxRelationPoints: 6 };
    const elements = [
      {
        type: "relation",
        id: 9_100_011,
        tags: { type: "multipolygon", place: "archipelago", name: "Huge Test Archipelago" },
        members: [{ type: "way", ref: 1, role: "outer", geometry: ring(14.6, 35.3, 14.9, 35.6) }, { type: "way", ref: 2, role: "outer", geometry: ring(14.6, 35.3, 14.61, 35.31) }],
      },
      { type: "way", id: 9_100_012, tags: { place: "island", name: "Small Test Island" }, geometry: ring(14.7, 35.4, 14.75, 35.45) },
    ];
    const transport: Transport = async () => makeResponse(200, new TextEncoder().encode(JSON.stringify({ elements })));
    await withRollback(async (tx) => {
      await setUpMalta(tx);
      expect(await importCoarseFeatures(tx, "MT", { transport, overpass: limited })).toEqual({ islands: 1, archipelagos: 0, gulfs: 0, towns: 0, splits: 0, blocksSkipped: 0, skippedLarge: 1 });
      expect(await malta(tx, "Huge Test Archipelago")).toHaveLength(0);
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

  it("keeps the type (and so the public id) of a bay the fine gazetteer imported", async () => {
    const elements = [{ type: "way", id: 9_100_011, tags: { natural: "bay", name: "Fine Test Bay" }, geometry: ring(14.7, 35.8, 15.0, 36.0) }];
    const transport: Transport = async () => makeResponse(200, new TextEncoder().encode(JSON.stringify({ elements })));
    await withRollback(async (tx) => {
      await setUpMalta(tx);
      // A bay has no public id; as `gulf` it would get an rg_ id that the next fine run drops again.
      await tx.execute(sql`INSERT INTO geo_objects (id, type, origin, osm_id, public_id, tags, geom)
        VALUES (gen_random_uuid(), 'bay', 'osm', 'way/9100011', null, '{"natural":"bay","name":"Fine Test Bay"}'::jsonb,
                ST_Multi(ST_GeomFromText('POLYGON((14.7 35.8, 15.0 35.8, 15.0 36.0, 14.7 36.0, 14.7 35.8))', 4326)))`);
      expect(await importCoarseFeatures(tx, "MT", { transport, overpass })).toMatchObject({ gulfs: 1 });
      const { rows } = await tx.execute<{ type: string; public_id: string }>(sql`
        SELECT type, public_id FROM geo_objects WHERE osm_id = 'way/9100011' AND valid_to IS NULL`);
      expect(rows).toEqual([{ type: "bay", public_id: null }]);
    });
  }, 120_000);

  it("fails before any query when the country is not stored", async () => {
    await withRollback(async (tx) => {
      await expect(importCoarseFeatures(tx, "MT", { transport: fixtureTransport(), overpass })).rejects.toThrow(/no country object/);
    });
  });
});

describe("stages gazetteer.seas and gazetteer.coarse", () => {
  const run = (params: Record<string, unknown>) => ({ id: "00000000-0000-0000-0000-000000000000", params });

  it("seas are one job of their own stage, before the countries", async () => {
    await withRollback(async (tx) => {
      expect(gazetteerSeasStage).toMatchObject({ name: "gazetteer.seas", queue: "gazetteer.coarse" });
      expect(await gazetteerSeasStage.plan(tx, run({}))).toEqual([{ key: "seas" }]);
    });
  });

  it("plans one job per configured country and no seas job; params.countries limits it", async () => {
    await withRollback(async (tx) => {
      const all = await gazetteerCoarseStage.plan(tx, run({}));
      expect(all).toEqual(Object.keys(getConfig().subdivisions.countries).map((country) => ({ key: country, country })));
      expect(all.map((j) => j.key)).not.toContain("seas");
      expect(await gazetteerCoarseStage.plan(tx, run({ countries: ["GR"] }))).toEqual([{ key: "GR", country: "GR" }]);
      await expect(gazetteerCoarseStage.plan(tx, run({ countries: ["XX"] }))).rejects.toThrow(/XX/);
    });
  });
});
