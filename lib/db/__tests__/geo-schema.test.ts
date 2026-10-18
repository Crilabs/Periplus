import { eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { asGeoJson, geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, places, restrictedAreas, tiles } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { testDb } from "@/test/db";

/** drizzle wraps driver errors ("Failed query"); the Postgres message lives on `cause`. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    const err = e as Error;
    return `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`;
  }
  throw new Error("expected promise to reject");
}

const point = (lon: number, lat: number) => geomFromGeoJson({ type: "Point", coordinates: [lon, lat] });

async function insertGeoObject(values: Partial<PgInsertValue<typeof geoObjects>> = {}): Promise<string> {
  const [row] = await testDb()
    .insert(geoObjects)
    .values({ type: "bay", origin: "osm", geom: point(23.4, 37.4), ...values })
    .returning({ id: geoObjects.id });
  return row!.id;
}

async function insertPlace(lon: number, lat: number): Promise<string> {
  const geoObjectId = await insertGeoObject({ geom: point(lon, lat) });
  const [row] = await testDb()
    .insert(places)
    .values({ geoObjectId, kind: "anchorage", position: point(lon, lat) })
    .returning({ id: places.id });
  return row!.id;
}

/** One row per stable table; returns the table name and the row's id. */
const stableRows: Record<string, () => Promise<string>> = {
  geo_objects: () => insertGeoObject(),
  geo_names: async () => {
    const geoObjectId = await insertGeoObject();
    const [row] = await testDb()
      .insert(geoNames)
      .values({ geoObjectId, name: "Órmos", nameNormalized: "ormos", language: "el", script: "greek", origin: "osm" })
      .returning({ id: geoNames.id });
    return row!.id;
  },
  places: () => insertPlace(23.41, 37.41),
  tiles: async () => {
    const id = `test:${newId()}`;
    await testDb()
      .insert(tiles)
      .values({
        id,
        bbox: geomFromGeoJson({
          type: "Polygon",
          coordinates: [[[23, 37], [23.25, 37], [23.25, 37.25], [23, 37.25], [23, 37]]],
        }),
      });
    return id;
  },
  restricted_areas: async () => {
    const [row] = await testDb()
      .insert(restrictedAreas)
      .values({ kind: "military", geom: point(23.5, 37.5) })
      .returning({ id: restrictedAreas.id });
    return row!.id;
  },
};

describe("geo schema", () => {
  it.each(Object.keys(stableRows))("%s rejects DELETE", async (table) => {
    const id = await stableRows[table]!();
    const message = await rejectionMessage(testDb().execute(sql`delete from ${sql.identifier(table)} where id = ${id}`));
    expect(message).toMatch(new RegExp(`${table} rows are never deleted`));
  });

  it("changing geo_objects.geom writes one history row; changing tags writes none", async () => {
    const db = testDb();
    const id = await insertGeoObject();
    await db.update(geoObjects).set({ tags: { natural: "bay" } }).where(eq(geoObjects.id, id));
    await db.update(geoObjects).set({ geom: point(23.5, 37.5) }).where(eq(geoObjects.id, id));
    const history = await db.execute<{ old_row: { geom: unknown; tags: unknown } }>(
      sql`select old_row from geo_objects_history where row_id = ${id}`,
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]!.old_row.tags).toEqual({ natural: "bay" });
    expect(history.rows[0]!.old_row.geom).toMatchObject({ type: "Point", coordinates: [23.4, 37.4] });
  });

  it("places.tile_id follows position, including a point exactly on a tile edge", async () => {
    const db = testDb();
    const id = await insertPlace(23.3, 37.3);
    const tileOf = async () =>
      (await db.select({ tileId: places.tileId }).from(places).where(eq(places.id, id)))[0]!.tileId;
    expect(await tileOf()).toBe("q025:813:509");
    // position (23.25, 37.75) → "q025:813:511": an edge coordinate belongs to the tile east / north of it
    await db.update(places).set({ position: point(23.25, 37.75) }).where(eq(places.id, id));
    expect(await tileOf()).toBe("q025:813:511");
  });

  it("tile_id_for handles negative coordinates and tile edges", async () => {
    const result = await testDb().execute<{ a: string; b: string; c: string }>(sql`select
      tile_id_for(ST_SetSRID(ST_MakePoint(23.25, 37.75), 4326)) as a,
      tile_id_for(ST_SetSRID(ST_MakePoint(-0.1, -0.25), 4326)) as b,
      tile_id_for(ST_SetSRID(ST_MakePoint(-180, -90), 4326)) as c`);
    expect(result.rows[0]).toEqual({ a: "q025:813:511", b: "q025:719:359", c: "q025:0:0" });
  });

  it("osm_id is unique only among valid rows", async () => {
    const db = testDb();
    const osmId = `node/${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const first = await insertGeoObject({ osmId });
    expect(await rejectionMessage(insertGeoObject({ osmId }))).toMatch(/geo_objects_osm_id_valid_unique/);
    await db.update(geoObjects).set({ validTo: "2026-01-01" }).where(eq(geoObjects.id, first));
    await expect(insertGeoObject({ osmId })).resolves.toEqual(expect.any(String));
  });

  it("centroid lies on the surface and geometries round-trip as GeoJSON", async () => {
    const db = testDb();
    // U-shaped bay: its plain centroid would fall into the notch, outside the polygon
    const id = await insertGeoObject({
      type: "area",
      geom: geomFromGeoJson({
        type: "Polygon",
        coordinates: [[[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3], [0, 0]]],
      }),
    });
    const [row] = await db
      .select({
        geom: asGeoJson(geoObjects.geom),
        onSurface: sql<boolean>`ST_Intersects(${geoObjects.centroid}, ${geoObjects.geom})`,
      })
      .from(geoObjects)
      .where(eq(geoObjects.id, id));
    expect(row!.geom.type).toBe("Polygon");
    expect(row!.onSurface).toBe(true);
  });
});
