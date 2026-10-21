import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geoObjects } from "@/lib/db/schema";
import { computeAreaPolygon } from "@/lib/domain/areas/polygon";
import { withRollback } from "@/test/db";
import { insertScene, LAND_WKT, sceneConfig } from "@/test/fixtures/areas/scene";

const cfg = sceneConfig();

/**
 * `inland`: the polygon meets land more than 1000 m (`inlandCutM`) inland. The cut leaves the polygon's edge on the
 * shrunk land's boundary, where floating-point slivers make `ST_Intersects` with the very same -1000 m buffer true
 * (intersection area 0 m²); 1 m of tolerance tests the property itself. The implementation buffers land clipped to the
 * area's surroundings, so `ST_Buffer(geography)` may pick another projection than for the whole land polygon here: the
 * same -1000 m buffer may differ by millimetres, a sliver of some 100 m² along the cut.
 */
async function check(db: Db, geom: string) {
  const { rows } = await db.execute<{ valid: boolean; type: string; inland: boolean; area: number; inlandArea: number }>(sql`
    select ST_IsValid(g) as valid, ST_GeometryType(g) as type, ST_Area(g::geography) as area,
           ST_Intersects(g, ST_Buffer(land::geography, -1001)::geometry) as inland,
           ST_Area(ST_Intersection(g, ST_Buffer(land::geography, -1000)::geometry)::geography) as "inlandArea"
    from (select ${geom}::geometry as g, ST_GeomFromText(${LAND_WKT}, 4326) as land) x`);
  return rows[0]!;
}

async function insertPoint(db: Db, lon: number, lat: number): Promise<string> {
  const [row] = await db
    .insert(geoObjects)
    .values({ type: "harbour", origin: "osm", geom: sql`ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)` })
    .returning({ id: geoObjects.id });
  return row!.id;
}

describe("computeAreaPolygon", () => {
  it("never keeps land more than inlandCutM inland between members on both sides of a peninsula (Review Focus 4)", () =>
    withRollback(async (db) => {
      const { objects: o } = await insertScene(db);
      const res = await computeAreaPolygon(db, [o.velani!, o.dorkasi!, o.sarandi!], cfg);
      expect(res?.origin).toBe("computed");
      const c = await check(db, res!.geom);
      expect(c).toMatchObject({ valid: true, type: "ST_MultiPolygon", inland: false });
      expect(c.inlandArea).toBeLessThan(1000);
      expect(c.area).toBeGreaterThan(0);
    }));

  it("buffers two members to a valid polygon", () =>
    withRollback(async (db) => {
      const { objects: o } = await insertScene(db);
      const res = await computeAreaPolygon(db, [o.lefkori!, o.petrili!], cfg);
      expect(res?.origin).toBe("computed");
      expect(await check(db, res!.geom)).toMatchObject({ valid: true, type: "ST_MultiPolygon" });
    }));

  it("buffers three collinear members to a valid polygon", () =>
    withRollback(async (db) => {
      const ids = [await insertPoint(db, 10.6, 40.7), await insertPoint(db, 10.7, 40.7), await insertPoint(db, 10.8, 40.7)];
      const res = await computeAreaPolygon(db, ids, cfg);
      expect(res?.origin).toBe("computed");
      const c = await check(db, res!.geom);
      expect(c).toMatchObject({ valid: true, type: "ST_MultiPolygon" });
      expect(c.area).toBeGreaterThan(0);
    }));

  it("returns null for fewer than minMembers members", () =>
    withRollback(async (db) => {
      const { objects: o } = await insertScene(db);
      expect(await computeAreaPolygon(db, [o.velani!], cfg)).toBeNull();
      expect(await computeAreaPolygon(db, [], cfg)).toBeNull();
    }));

  it("takes a gulf member that covers the other members as the polygon", () =>
    withRollback(async (db) => {
      const { objects: o } = await insertScene(db);
      const res = await computeAreaPolygon(db, [o.teranos!, o.lefkori!, o.petrili!], cfg, [o.teranos!]);
      expect(res?.origin).toBe("gulf");
      const { rows } = await db.execute<{ same: boolean }>(sql`
        select ST_Equals(${res!.geom}::geometry, g.geom) as same from geo_objects g where g.id = ${o.teranos!}`);
      expect(rows[0]!.same).toBe(true);
      // A member outside the gulf (one of three others) is below gulfCoverShare: the hull is computed.
      const mixed = await computeAreaPolygon(db, [o.teranos!, o.lefkori!, o.petrili!, o.plakari!], cfg, [o.teranos!]);
      expect(mixed?.origin).toBe("computed");
    }));

  it("applies the gulf rule only to members the bot typed gulf: a small bay with a harbour inside is no polygon", () =>
    withRollback(async (db) => {
      const { objects: o } = await insertScene(db);
      const [bay] = await db
        .insert(geoObjects)
        .values({ type: "bay", origin: "osm", geom: sql`ST_Multi(ST_MakeEnvelope(10.6, 40.1, 10.85, 40.35, 4326))` })
        .returning({ id: geoObjects.id });
      const res = await computeAreaPolygon(db, [bay!.id, o.lefkori!, o.petrili!], cfg);
      expect(res?.origin).toBe("computed");
      // The same object typed gulf by the bot may stand for the area.
      expect((await computeAreaPolygon(db, [bay!.id, o.lefkori!, o.petrili!], cfg, [bay!.id]))?.origin).toBe("gulf");
    }));
});
