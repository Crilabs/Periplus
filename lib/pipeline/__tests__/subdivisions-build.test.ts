import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { makeResponse, type Transport } from "@/lib/adapters/http";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, subdivisions } from "@/lib/db/schema";
import type { PlannedSubdivision } from "@/lib/domain/subdivisions/plan";
import { applySubdivisionPlan, loadAdminUnits } from "@/lib/domain/subdivisions/store";
import { importCoarse, importSeas } from "@/lib/pipeline/gazetteer/coarse";
import { assignCoarse, buildSubdivisions, MissingCountries } from "@/lib/pipeline/subdivisions";
import { startSubdivisionsBuildRun } from "@/lib/pipeline/subdivisions-run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { withRollback } from "@/test/db";

// Rate limiting is covered by the http tests; its bucket rows would stay locked by the test transaction.
vi.mock("@/lib/domain/rate-limit", () => ({ takeToken: async () => ({ ok: true }) }));

const TODAY = "2026-10-20";
const LATER = "2026-10-21";
const mrgids = getConfig().subdivisions.mediterranean.marineRegionsMrgids;

/** Synthetic geometries lie at 10-12 E x 45-46 N (outside the pilot box). */
function square(w: number, s: number, e: number, n: number): string {
  return `ST_SetSRID(ST_GeomFromText('POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))'), 4326)`;
}

let seq = 100;
async function insertUnit(
  tx: Db,
  box: [number, number, number, number],
  over: { type?: "country" | "admin_region"; level?: number; tags?: Record<string, string>; configKey?: string } = {},
): Promise<string> {
  seq++;
  const [w, s, e, n] = box;
  const res = await tx.execute<{ id: string }>(sql.raw(`
    INSERT INTO geo_objects (id, type, origin, osm_id, admin_level, config_key, tags, geom)
    VALUES (gen_random_uuid(), '${over.type ?? "admin_region"}', 'osm', 'relation/${seq}9990', ${over.level ?? 4},
            ${over.configKey ? `'${over.configKey}'` : "NULL"}, '${JSON.stringify(over.tags ?? { country: "HR" })}'::jsonb, ST_Multi(${square(w, s, e, n)}))
    RETURNING id`));
  return res.rows[0]!.id;
}

async function insertLand(tx: Db, box: [number, number, number, number]): Promise<void> {
  const [w, s, e, n] = box;
  await tx.execute(sql.raw(`INSERT INTO land_polygons (id, geom, dataset_version) VALUES (gen_random_uuid(), ${square(w, s, e, n)}, 'test')`));
}

/**
 * One country object per configured country (none for `except`), far from any sea and without `osm_id`, so
 * `loadAdminUnits` never plans them: they only satisfy the check that every configured country was imported.
 */
async function insertCountries(tx: Db, except: string[] = []): Promise<void> {
  for (const country of Object.keys(getConfig().subdivisions.countries).filter((c) => !except.includes(c))) {
    await tx.execute(sql.raw(`
      INSERT INTO geo_objects (id, type, origin, admin_level, tags, geom)
      VALUES (gen_random_uuid(), 'country', 'osm', 2, '${JSON.stringify({ country })}'::jsonb, ST_Multi(${square(-40, -60, -39.9, -59.9)}))`));
  }
}

function entry(key: string, geoObjectId: string | null, over: Partial<PlannedSubdivision> = {}): PlannedSubdivision {
  return {
    key,
    country: "HR",
    geoObjectId,
    memberGeoObjectIds: geoObjectId ? [geoObjectId] : [],
    cutGeoObjectIds: [],
    adminLevel: 4,
    status: "active",
    statusReason: null,
    names: {},
    ...over,
  };
}

async function validRows(tx: Db, keys: string[]) {
  return tx.select().from(subdivisions).where(and(inArray(subdivisions.key, keys), isNull(subdivisions.validTo)));
}

describe("applySubdivisionPlan", () => {
  it("inserts with sd_ ids, land_geom and a polygon padded with 12 sm of water around the land", async () => {
    await withRollback(async (tx) => {
      const a = await insertUnit(tx, [10, 45, 11, 46]);
      await insertLand(tx, [10.2, 45.2, 10.8, 45.8]);
      const result = await applySubdivisionPlan(tx, [entry("HR-T1", a)], TODAY);
      expect(result).toMatchObject({ inserted: 1, replaced: 0, unchanged: 0, deviations: [] });
      const [row] = await validRows(tx, ["HR-T1"]);
      expect(row!.publicId).toMatch(/^sd_/);
      expect(row!.geoObjectId).toBe(a);
      const { rows } = await tx.execute<{ covers: boolean; land_in_unit: boolean; land_area: number; wider: boolean }>(sql`
        SELECT ST_Covers(s.geom, g.geom) AS covers,
               ST_Covers(g.geom, s.land_geom) AS land_in_unit,
               ST_Area(s.land_geom::geography)::float AS land_area,
               ST_Area(s.geom::geography) > ST_Area(g.geom::geography) AS wider
        FROM subdivisions s JOIN geo_objects g ON g.id = s.geo_object_id WHERE s.id = ${row!.id}`);
      expect(rows[0]).toMatchObject({ covers: true, land_in_unit: true, wider: true });
      // 0.6 x 0.6 degrees at 45 N: about 3.4e9 m2 of land.
      expect(rows[0]!.land_area).toBeGreaterThan(3e9);
      expect(rows[0]!.land_area).toBeLessThan(4e9);
    });
  });

  it("a unit without land has no land_geom but keeps its polygon", async () => {
    await withRollback(async (tx) => {
      const a = await insertUnit(tx, [10, 45, 11, 46]);
      await applySubdivisionPlan(tx, [entry("HR-T2", a)], TODAY);
      const [row] = await tx.select({ land: sql<boolean>`land_geom is null` }).from(subdivisions).where(eq(subdivisions.key, "HR-T2"));
      expect(row!.land).toBe(true);
    });
  });

  it("second apply with same plan changes nothing", async () => {
    await withRollback(async (tx) => {
      const a = await insertUnit(tx, [10, 45, 11, 46]);
      await insertLand(tx, [10.2, 45.2, 10.8, 45.8]);
      const plan = [entry("HR-T3", a)];
      await applySubdivisionPlan(tx, plan, TODAY);
      const [before] = await validRows(tx, ["HR-T3"]);
      expect(await applySubdivisionPlan(tx, plan, LATER)).toMatchObject({ inserted: 0, replaced: 0, unchanged: 1, ended: 0, deviations: [] });
      const rows = await tx.select().from(subdivisions).where(eq(subdivisions.key, "HR-T3"));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(before!.id);
      expect(rows[0]!.publicId).toBe(before!.publicId);
    });
  });

  it("changed config replaces an unbuilt row and only reports a built one", async () => {
    await withRollback(async (tx) => {
      const a = await insertUnit(tx, [10, 45, 11, 46]);
      const b = await insertUnit(tx, [11, 45, 12, 46]);
      await applySubdivisionPlan(tx, [entry("HR-T4", a), entry("HR-T5", b)], TODAY);
      const [built] = await validRows(tx, ["HR-T5"]);
      await tx.update(subdivisions).set({ builtAt: new Date() }).where(eq(subdivisions.id, built!.id));
      const [unbuilt] = await validRows(tx, ["HR-T4"]);

      const changed = [
        entry("HR-T4", a, { status: "excluded", statusReason: "test" }),
        entry("HR-T5", b, { status: "excluded", statusReason: "test" }),
      ];
      const result = await applySubdivisionPlan(tx, changed, LATER);
      expect(result).toMatchObject({ inserted: 0, replaced: 1, unchanged: 0 });
      expect(result.deviations).toEqual([{ key: "HR-T5", reason: expect.stringContaining("status active -> excluded") }]);

      const [replacement] = await validRows(tx, ["HR-T4"]);
      expect(replacement!.id).not.toBe(unbuilt!.id);
      expect(replacement!.publicId).not.toBe(unbuilt!.publicId);
      expect(replacement).toMatchObject({ status: "excluded", statusReason: "test", validFrom: LATER });
      const [old] = await tx.select().from(subdivisions).where(eq(subdivisions.id, unbuilt!.id));
      expect(old!.validTo).toBe(LATER);
      const [kept] = await validRows(tx, ["HR-T5"]);
      expect(kept).toMatchObject({ id: built!.id, publicId: built!.publicId, status: "active" });
    });
  });

  it("a key that left the plan ends when unbuilt and is reported when built", async () => {
    await withRollback(async (tx) => {
      const a = await insertUnit(tx, [10, 45, 11, 46]);
      const b = await insertUnit(tx, [11, 45, 12, 46]);
      await applySubdivisionPlan(tx, [entry("HR-T6", a), entry("HR-T7", b)], TODAY);
      await tx.update(subdivisions).set({ builtAt: new Date() }).where(eq(subdivisions.key, "HR-T7"));
      const result = await applySubdivisionPlan(tx, [], LATER);
      expect(result).toMatchObject({ ended: expect.any(Number) });
      expect(result.deviations.map((d) => d.key)).toContain("HR-T7");
      expect(await validRows(tx, ["HR-T6"])).toHaveLength(0);
      expect(await validRows(tx, ["HR-T7"])).toHaveLength(1);
    });
  });

  it("cuts a unit out of the row and keeps its land out of the land_geom", async () => {
    await withRollback(async (tx) => {
      const whole = await insertUnit(tx, [10, 45, 12, 46]);
      const cut = await insertUnit(tx, [11, 45, 12, 46]);
      await insertLand(tx, [10.2, 45.2, 11.8, 45.8]);
      await applySubdivisionPlan(tx, [entry("HR-T8", whole, { cutGeoObjectIds: [cut] })], TODAY);
      const { rows } = await tx.execute<{ shared: number; land_east: number }>(sql`
        SELECT ST_Area(ST_Intersection(s.land_geom, c.geom)::geography)::float AS shared,
               ST_Area(ST_Intersection(s.land_geom, ${sql.raw(square(11.01, 45, 12, 46))})::geography)::float AS land_east
        FROM subdivisions s, geo_objects c WHERE s.key = 'HR-T8' AND s.valid_to IS NULL AND c.id = ${cut}::uuid`);
      expect(rows[0]!.shared).toBe(0);
      expect(rows[0]!.land_east).toBe(0);
    });
  });

  it("does not change the geo object of a built split group or merge, it reports a deviation", async () => {
    await withRollback(async (tx) => {
      const a = await insertUnit(tx, [10, 45, 11, 46]);
      const b = await insertUnit(tx, [11, 45, 12, 46]);
      const group = entry("HR-GRPB", null, { memberGeoObjectIds: [a, b], names: { en: "Group" } });
      await applySubdivisionPlan(tx, [group], TODAY);
      await tx.update(subdivisions).set({ builtAt: new Date() }).where(eq(subdivisions.key, "HR-GRPB"));
      const area = async () =>
        (await tx.execute<{ g: string }>(sql`SELECT ST_AsEWKT(geom) AS g FROM geo_objects WHERE config_key = 'HR-GRPB' AND valid_to IS NULL`)).rows[0]!.g;
      const before = await area();
      const c = await insertUnit(tx, [12, 45, 13, 46]);
      const result = await applySubdivisionPlan(tx, [{ ...group, memberGeoObjectIds: [a, b, c] }], LATER);
      expect(await area()).toBe(before);
      expect(result).toMatchObject({ replaced: 0, unchanged: 0 });
      expect(result.deviations.map((d) => d.key)).toEqual(["HR-GRPB"]);
      expect(result.deviations[0]!.reason).toContain("geo object geometry");
    });
  });

  it("a split group or merge gets its own admin_region geo object from the union of its members", async () => {
    await withRollback(async (tx) => {
      const a = await insertUnit(tx, [10, 45, 11, 46]);
      const b = await insertUnit(tx, [11, 45, 12, 46]);
      const group = entry("HR-GRP", null, { memberGeoObjectIds: [a, b], names: { en: "Group", de: "Gruppe" } });
      await applySubdivisionPlan(tx, [group], TODAY);
      const [made] = await tx.select().from(geoObjects).where(and(eq(geoObjects.configKey, "HR-GRP"), isNull(geoObjects.validTo)));
      expect(made).toMatchObject({ type: "admin_region", adminLevel: 4 });
      const [row] = await validRows(tx, ["HR-GRP"]);
      expect(row!.geoObjectId).toBe(made!.id);
      const { rows } = await tx.execute<{ area: number }>(sql`SELECT ST_Area(geom::geography)::float AS area FROM geo_objects WHERE id = ${made!.id}::uuid`);
      expect(rows[0]!.area).toBeGreaterThan(1.5e10);
      expect(await applySubdivisionPlan(tx, [group], LATER)).toMatchObject({ unchanged: 1, replaced: 0 });
    });
  });
});

describe("applySubdivisionPlan with an island group", () => {
  it("pads every island of the land with 12 sm of water", async () => {
    await withRollback(async (tx) => {
      const a = await insertUnit(tx, [10, 45, 11, 46]);
      await insertLand(tx, [10.1, 45.1, 10.12, 45.12]);
      await insertLand(tx, [10.8, 45.8, 10.82, 45.82]);
      await applySubdivisionPlan(tx, [entry("HR-T9", a)], TODAY);
      const { rows } = await tx.execute<{ west: boolean; east: boolean }>(sql`
        SELECT ST_Covers(s.geom, ST_SetSRID(ST_MakePoint(10.11, 44.95), 4326)) AS west,
               ST_Covers(s.geom, ST_SetSRID(ST_MakePoint(10.81, 46.0), 4326)) AS east
        FROM subdivisions s WHERE s.key = 'HR-T9' AND s.valid_to IS NULL`);
      // Both points lie outside the unit polygon, about 16 and 20 km from their island.
      expect(rows[0]).toEqual({ west: true, east: true });
    });
  });
});

describe("loadAdminUnits", () => {
  it("marks units within 2 km of a configured sea as touching it, farther ones and unconfigured seas not", async () => {
    await withRollback(async (tx) => {
      const insertSea = (mrgid: number, box: [number, number, number, number]) =>
        tx.execute(sql.raw(`
          INSERT INTO geo_objects (id, type, origin, tags, geom)
          VALUES (gen_random_uuid(), 'sea', 'marine_regions', '{"mrgid": "${mrgid}"}'::jsonb, ST_Multi(${square(...box)}))`));
      await insertSea(mrgids[0]!, [10, 45, 10.5, 46]);
      await insertSea(999_999, [11.5, 45, 12, 46]);
      // At 45.5 N, 0.01 degrees of longitude are about 780 m.
      const overlapping = await insertUnit(tx, [10.4, 45.2, 10.45, 45.8]);
      const near = await insertUnit(tx, [10.52, 45.2, 10.6, 45.8]);
      const far = await insertUnit(tx, [10.53, 45.2, 10.6, 45.8]);
      const nextToOtherSea = await insertUnit(tx, [11.3, 45.2, 11.49, 45.8]);
      const units = await loadAdminUnits(tx, mrgids);
      const touches = (id: string) => units.find((u) => u.geoObjectId === id)?.touchesMediterranean;
      expect(touches(overlapping)).toBe(true);
      expect(touches(near)).toBe(true);
      expect(touches(far)).toBe(false);
      expect(touches(nextToOtherSea)).toBe(false);
    });
  });
});

describe("importSeas", () => {
  it("is idempotent via tags.mrgid and names the sea in English", async () => {
    await withRollback(async (tx) => {
      const count = async () =>
        Number(
          (
            await tx.execute<{ n: number }>(sql`
              SELECT count(*)::int AS n FROM geo_objects WHERE type = 'sea' AND origin = 'marine_regions' AND valid_to IS NULL
                AND tags->>'mrgid' IN (${sql.join(mrgids.map((m) => sql`${String(m)}`), sql`, `)})`)
          ).rows[0]!.n,
        );
      const before = await count();
      const created = await importSeas(tx, { transport: fixtureTransport() });
      expect(created).toBe(mrgids.length - before);
      expect(await count()).toBe(mrgids.length);
      expect(await importSeas(tx, { transport: fixtureTransport() })).toBe(0);
      expect(await count()).toBe(mrgids.length);
      const { rows } = await tx.execute<{ name: string }>(sql`
        SELECT n.name FROM geo_objects g JOIN geo_names n ON n.geo_object_id = g.id AND n.valid_to IS NULL
        WHERE g.type = 'sea' AND g.tags->>'mrgid' = '3315' AND g.valid_to IS NULL AND n.language = 'en'`);
      expect(rows[0]!.name).toBe("Aegean Sea");
    });
  }, 120_000);

  it("a configured MRGID missing in the answer is an error naming it", async () => {
    const empty: Transport = async () => makeResponse(200, new TextEncoder().encode('{"type":"FeatureCollection","features":[]}'));
    await withRollback(async (tx) => {
      await expect(importSeas(tx, { transport: empty })).rejects.toThrow(new RegExp(`MRGID ${mrgids[0]}\\b`));
    });
  });
});

describe("importCoarse", () => {
  async function unitsOf(tx: Db, country: string) {
    return tx
      .select({ type: geoObjects.type, level: geoObjects.adminLevel, tags: geoObjects.tags, osmId: geoObjects.osmId })
      .from(geoObjects)
      .where(and(sql`${geoObjects.tags}->>'country' = ${country}`, inArray(geoObjects.type, ["country", "admin_region"]), isNull(geoObjects.validTo)));
  }

  it("MT: one country geo object with admin_level 2", async () => {
    await withRollback(async (tx) => {
      expect(await importCoarse(tx, "MT", { transport: fixtureTransport() })).toEqual({ countries: 1, regions: 0 });
      const units = await unitsOf(tx, "MT");
      expect(units).toHaveLength(1);
      expect(units[0]).toMatchObject({ type: "country", level: 2 });
      expect((units[0]!.tags as Record<string, string>)["ISO3166-1"]).toBe("MT");
      expect(await importCoarse(tx, "MT", { transport: fixtureTransport() })).toEqual({ countries: 1, regions: 0 });
      expect(await unitsOf(tx, "MT")).toHaveLength(1);
    });
  });

  it("an extra relation of admin_level 2 is stored as admin_region, never as a second country", async () => {
    const ring = (w: number, s: number, e: number, n: number) => [
      { lat: s, lon: w }, { lat: s, lon: e }, { lat: n, lon: e }, { lat: n, lon: w }, { lat: s, lon: w },
    ];
    const extraId = getConfig().subdivisions.extra.find((e) => e.country === "CY")!.osmRelationId;
    const elements = [
      {
        type: "relation", id: 9_000_001,
        tags: { boundary: "administrative", admin_level: "2", "ISO3166-1": "CY", name: "Testland", wikidata: "Q9000001" },
        members: [{ type: "way", ref: 1, role: "outer", geometry: ring(10, 45, 12, 46) }],
      },
      {
        type: "relation", id: extraId,
        tags: { boundary: "administrative", admin_level: "2", name: "Testbase", wikidata: "Q9000002" },
        members: [{ type: "way", ref: 2, role: "outer", geometry: ring(11, 45, 11.5, 45.5) }],
      },
    ];
    const transport: Transport = async () => makeResponse(200, new TextEncoder().encode(JSON.stringify({ elements })));
    await withRollback(async (tx) => {
      expect(await importCoarse(tx, "CY", { transport })).toEqual({ countries: 1, regions: 1 });
      const units = await unitsOf(tx, "CY");
      expect(units.filter((u) => u.type === "country")).toHaveLength(1);
      expect(units.find((u) => u.osmId === `relation/${extraId}`)).toMatchObject({ type: "admin_region", level: 2 });
    });
  });

  it("PS: the configured countryRelation is the country, though tagged boundary=disputed without admin_level (B2)", async () => {
    expect(getConfig().subdivisions.countries.PS!.countryRelation).toBe(1703814);
    const ring = (w: number, s: number, e: number, n: number) => [
      { lat: s, lon: w }, { lat: s, lon: e }, { lat: n, lon: e }, { lat: n, lon: w }, { lat: s, lon: w },
    ];
    const elements = [
      {
        type: "relation", id: 1703814,
        tags: { boundary: "disputed", type: "boundary", name: "Palestinian Territories", "ISO3166-1": "PS" },
        members: [{ type: "way", ref: 1, role: "outer", geometry: ring(34.2, 31.2, 35.6, 32.6) }],
      },
    ];
    const queries: string[] = [];
    const transport: Transport = async (req) => {
      queries.push(decodeURIComponent(String(req.body)));
      return makeResponse(200, new TextEncoder().encode(JSON.stringify({ elements })));
    };
    await withRollback(async (tx) => {
      expect(await importCoarse(tx, "PS", { transport })).toEqual({ countries: 1, regions: 0 });
      expect(queries.some((q) => q.includes("relation(id:1703814)"))).toBe(true);
      const units = await unitsOf(tx, "PS");
      expect(units).toHaveLength(1);
      expect(units[0]).toMatchObject({ type: "country", level: 2, osmId: "relation/1703814" });
      expect((units[0]!.tags as Record<string, string>).country).toBe("PS");
    });
  });

  it("HR: the 21 counties, without Vojvodina from the leaking area query", async () => {
    await withRollback(async (tx) => {
      expect(await importCoarse(tx, "HR", { transport: fixtureTransport() })).toEqual({ countries: 1, regions: 21 });
      const units = await unitsOf(tx, "HR");
      const regions = units.filter((u) => u.type === "admin_region");
      expect(regions).toHaveLength(21);
      expect(regions.every((u) => u.level === 4)).toBe(true);
      expect(regions.every((u) => (u.tags as Record<string, string>)["ISO3166-2"]?.startsWith("HR-"))).toBe(true);
      const { rows } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM geo_objects WHERE tags->>'ISO3166-2' LIKE 'RS-%'`);
      expect(rows[0]!.n).toBe(0);
    });
  }, 120_000);
});

describe("buildSubdivisions", () => {
  it("builds from the coarse gazetteer: units touching a sea, a key from the Qid, config that matches nothing reported", async () => {
    await withRollback(async (tx) => {
      await tx.execute(sql`UPDATE geo_objects SET valid_to = current_date WHERE type IN ('sea', 'country', 'admin_region') AND valid_to IS NULL AND origin IN ('marine_regions', 'osm') AND tags ? 'country'`);
      await tx.execute(sql`UPDATE subdivisions SET valid_to = current_date WHERE valid_to IS NULL AND built_at IS NULL`);
      const sea = String(mrgids[0]);
      await tx.execute(sql.raw(`
        INSERT INTO geo_objects (id, type, origin, tags, geom)
        VALUES (gen_random_uuid(), 'sea', 'marine_regions', '{"mrgid":"${sea}"}'::jsonb, ST_Multi(${square(11, 44, 12, 45)}))`));
      await insertUnit(tx, [10, 45.0, 11, 46], { tags: { country: "HR", "ISO3166-2": "HR-91" } });
      await insertUnit(tx, [11, 45.01, 12, 46], { tags: { country: "HR", wikidata: "Q4242" } });
      await insertUnit(tx, [10, 47, 11, 48], { tags: { country: "HR", "ISO3166-2": "HR-92" } });
      await insertLand(tx, [10.2, 45.2, 10.8, 45.8]);
      await insertLand(tx, [11.2, 45.2, 11.8, 45.8]);
      await insertCountries(tx);

      const result = await buildSubdivisions(tx, new Date("2026-10-20T10:00:00Z"));
      expect(result.planned).toBe(2);
      expect(result.inserted).toBe(2);
      const rows = await tx.select().from(subdivisions).where(and(isNull(subdivisions.validTo), eq(subdivisions.country, "HR")));
      expect(rows.map((r) => r.key).sort()).toEqual(["HR-91", "HR-Q4242"]);
      expect(result.warnings.join("\n")).toContain("GR-L");
    });
  });

  it("fails when a unit touching the Mediterranean has no land polygon, naming it and the import command", async () => {
    await withRollback(async (tx) => {
      await tx.execute(sql`UPDATE geo_objects SET valid_to = current_date WHERE type IN ('sea', 'country', 'admin_region') AND valid_to IS NULL AND origin IN ('marine_regions', 'osm') AND tags ? 'country'`);
      const sea = String(mrgids[0]);
      await tx.execute(sql.raw(`
        INSERT INTO geo_objects (id, type, origin, tags, geom)
        VALUES (gen_random_uuid(), 'sea', 'marine_regions', '{"mrgid":"${sea}"}'::jsonb, ST_Multi(${square(11, 44, 12, 45)}))`));
      await insertUnit(tx, [11, 45.01, 12, 46], { tags: { country: "HR", "ISO3166-2": "HR-93" } });
      // Land exists, but elsewhere (like the Saronic pilot land): the check is per unit, not "any land".
      await insertLand(tx, [10.2, 47.2, 10.8, 47.8]);
      await insertCountries(tx);
      await expect(buildSubdivisions(tx)).rejects.toThrow(/HR-93.*npx tsx scripts\/import-land-polygons\.ts --shp <land_polygons\.shp> --mediterranean/s);
    });
  });

  it("fails naming every configured country without a country object, writing no subdivision", async () => {
    await withRollback(async (tx) => {
      await tx.execute(sql`UPDATE geo_objects SET valid_to = current_date WHERE type IN ('sea', 'country', 'admin_region') AND valid_to IS NULL AND origin IN ('marine_regions', 'osm') AND tags ? 'country'`);
      const sea = String(mrgids[0]);
      await tx.execute(sql.raw(`
        INSERT INTO geo_objects (id, type, origin, tags, geom)
        VALUES (gen_random_uuid(), 'sea', 'marine_regions', '{"mrgid":"${sea}"}'::jsonb, ST_Multi(${square(11, 44, 12, 45)}))`));
      await insertUnit(tx, [11, 45.01, 12, 46], { tags: { country: "HR", "ISO3166-2": "HR-94" } });
      await insertLand(tx, [11.2, 45.2, 11.8, 45.8]);
      await insertCountries(tx, ["PS", "LY"]);
      const count = async () => (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM subdivisions`)).rows[0]!.n;
      const before = await count();
      const error = await buildSubdivisions(tx).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(MissingCountries);
      expect((error as MissingCountries).countries).toEqual(["LY", "PS"]);
      expect((error as Error).message).toMatch(/LY, PS/);
      expect(await count()).toBe(before);
    });
  });

  it("refuses to run without land polygons", async () => {
    await withRollback(async (tx) => {
      await tx.execute(sql`DELETE FROM land_polygons`);
      await expect(buildSubdivisions(tx)).rejects.toThrow(/land polygons missing/);
    });
  });
});

describe("startSubdivisionsBuildRun", () => {
  function fakeBoss(inserted: Array<{ queue: string; key: unknown }>): PgBoss {
    return {
      insert: async (queue: string, jobs: Array<{ id: string; data: { key: string } }>) => {
        inserted.push(...jobs.map((j) => ({ queue, key: j.data.key })));
        return jobs.map((j) => j.id);
      },
    } as unknown as PgBoss;
  }

  it("creates a system run with scope subdivisions: seas first, then countries, the build and the assignment", async () => {
    await withRollback(async (tx) => {
      await insertLand(tx, [10.2, 45.2, 10.8, 45.8]);
      const inserted: Array<{ queue: string; key: unknown }> = [];
      const { id } = await startSubdivisionsBuildRun(tx, fakeBoss(inserted), "test");
      const { rows } = await tx.execute<{ scope_type: string; scope_id: string; stages: string[]; params: unknown }>(
        sql`SELECT scope_type, scope_id, stages, params FROM runs WHERE id = ${id}::uuid`,
      );
      expect(rows[0]).toEqual({
        scope_type: "system",
        scope_id: "subdivisions",
        stages: ["gazetteer.seas", "gazetteer.coarse", "subdivisions.build", "subdivisions.assign"],
        params: {},
      });
      expect(inserted).toEqual([{ queue: "gazetteer.coarse", key: "seas" }]);
    });
  });

  it("keeps the countries to import again in the run params", async () => {
    await withRollback(async (tx) => {
      await insertLand(tx, [10.2, 45.2, 10.8, 45.8]);
      const { id } = await startSubdivisionsBuildRun(tx, fakeBoss([]), "test", { countries: ["PS"] });
      const { rows } = await tx.execute<{ params: unknown }>(sql`SELECT params FROM runs WHERE id = ${id}::uuid`);
      expect(rows[0]!.params).toEqual({ countries: ["PS"] });
      await expect(startSubdivisionsBuildRun(tx, fakeBoss([]), "test", { countries: ["XX"] })).rejects.toMatchObject({
        reason: "unknown_country",
        message: expect.stringContaining("XX"),
      });
    });
  });

  it("refuses to start without land polygons, before a run exists", async () => {
    await withRollback(async (tx) => {
      await tx.execute(sql`DELETE FROM land_polygons`);
      const runs = async () => (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM runs`)).rows[0]!.n;
      const before = await runs();
      const error = await startSubdivisionsBuildRun(tx, fakeBoss([]), "test").then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(RunScopeNotReady);
      expect((error as RunScopeNotReady).reason).toBe("land_missing");
      expect(await runs()).toBe(before);
    });
  });
});

describe("assignCoarse", () => {
  it("GR: assigns subdivision, sea and parent to the coarse objects of the country", async () => {
    await withRollback(async (tx) => {
      // Synthetic Greece at 10-12 E x 45-46 N: the country, one subdivision, a configured sea around it and an island.
      const country = await insertUnit(tx, [10, 45, 12, 46], { type: "country", level: 2, tags: { country: "GR", "ISO3166-1": "GR" } });
      await insertLand(tx, [10.2, 45.2, 11.8, 45.8]);
      await applySubdivisionPlan(tx, [entry("GR-T1", country, { country: "GR", adminLevel: 2 })], TODAY);
      const [sd] = await validRows(tx, ["GR-T1"]);
      const sea = await tx.execute<{ id: string }>(sql.raw(`
        INSERT INTO geo_objects (id, type, origin, tags, geom)
        VALUES (gen_random_uuid(), 'sea', 'marine_regions', '{"mrgid":"${mrgids[0]}"}'::jsonb, ST_Multi(${square(9.5, 44.5, 12.5, 46.5)}))
        RETURNING id`));
      const island = await tx.execute<{ id: string }>(sql.raw(`
        INSERT INTO geo_objects (id, type, origin, osm_id, tags, geom)
        VALUES (gen_random_uuid(), 'island', 'osm', 'way/${++seq}9991', '{}'::jsonb, ST_Multi(${square(10.5, 45.5, 10.6, 45.6)}))
        RETURNING id`));
      const islandRow = async () =>
        (await tx.select({ subdivisionId: geoObjects.subdivisionId, seaId: geoObjects.seaId }).from(geoObjects).where(eq(geoObjects.id, island.rows[0]!.id)))[0];
      expect(await islandRow()).toEqual({ subdivisionId: null, seaId: null });

      const result = await assignCoarse(tx, "GR");
      expect(result.subdivisions).toBeGreaterThanOrEqual(1);
      expect(result.seas).toBeGreaterThanOrEqual(1);
      expect(await islandRow()).toEqual({ subdivisionId: sd!.id, seaId: sea.rows[0]!.id });
    });
  });

  it("fails for a country without a country object", async () => {
    await withRollback(async (tx) => {
      await tx.execute(sql`UPDATE geo_objects SET valid_to = current_date WHERE type = 'country' AND valid_to IS NULL AND tags->>'country' = 'GR'`);
      await expect(assignCoarse(tx, "GR")).rejects.toThrow(/GR/);
    });
  });
});
