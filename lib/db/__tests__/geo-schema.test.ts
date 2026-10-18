import { eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { asGeoJson, geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, places, restrictedAreas, tiles } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import type { Db } from "@/lib/db/client";
import { withRollback } from "@/test/db";

/** drizzle wraps driver errors ("Failed query"); the Postgres message lives on `cause`. */
async function rejectionMessage(tx: Db, run: (tx: Db) => Promise<unknown>): Promise<string> {
  try {
    // savepoint, so the surrounding transaction survives the expected failure
    await tx.transaction(async (sp) => {
      await run(sp);
    });
  } catch (e) {
    const err = e as Error;
    return `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`;
  }
  throw new Error("expected promise to reject");
}

const point = (lon: number, lat: number) => geomFromGeoJson({ type: "Point", coordinates: [lon, lat] });

async function insertGeoObject(tx: Db, values: Partial<PgInsertValue<typeof geoObjects>> = {}): Promise<string> {
  const [row] = await tx
    .insert(geoObjects)
    .values({ type: "bay", origin: "osm", geom: point(23.4, 37.4), ...values })
    .returning({ id: geoObjects.id });
  return row!.id;
}

async function insertPlace(tx: Db, lon: number, lat: number): Promise<string> {
  const geoObjectId = await insertGeoObject(tx, { geom: point(lon, lat) });
  const [row] = await tx
    .insert(places)
    .values({ geoObjectId, kind: "anchorage", position: point(lon, lat) })
    .returning({ id: places.id });
  return row!.id;
}

/** Inserts one row per stable table and returns its id; `coreChange` / `otherChange` update one column. */
type StableCase = {
  insert: (tx: Db) => Promise<string>;
  coreChange: string;
  otherChange: string;
};

const stable: Record<string, StableCase> = {
  geo_objects: {
    insert: (tx) => insertGeoObject(tx),
    coreChange: "geom = ST_SetSRID(ST_MakePoint(23.5, 37.5), 4326)",
    otherChange: `tags = '{"natural":"bay"}'::jsonb`,
  },
  geo_names: {
    insert: async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      const [row] = await tx
        .insert(geoNames)
        .values({ geoObjectId, name: "Órmos", nameNormalized: "ormos", language: "el", script: "greek", origin: "osm" })
        .returning({ id: geoNames.id });
      return row!.id;
    },
    coreChange: "name = 'Other'",
    otherChange: "name_normalized = 'other'",
  },
  places: {
    insert: (tx) => insertPlace(tx, 23.41, 37.41),
    coreChange: "status = 'confirmed'",
    otherChange: "status_reason = 'checked'",
  },
  tiles: {
    insert: async (tx) => {
      const id = `test:${newId()}`;
      await tx.insert(tiles).values({
        id,
        bbox: geomFromGeoJson({
          type: "Polygon",
          coordinates: [[[23, 37], [23.25, 37], [23.25, 37.25], [23, 37.25], [23, 37]]],
        }),
      });
      return id;
    },
    coreChange: "has_coast = NOT has_coast",
    otherChange: "priority = 5",
  },
  restricted_areas: {
    insert: async (tx) => {
      const [row] = await tx
        .insert(restrictedAreas)
        .values({ kind: "military", geom: point(23.5, 37.5) })
        .returning({ id: restrictedAreas.id });
      return row!.id;
    },
    coreChange: "kind = 'cable'",
    otherChange: "source_ref = 'ref'",
  },
};

describe("geo schema", () => {
  it.each(Object.keys(stable))("%s rejects DELETE", (table) =>
    withRollback(async (tx) => {
      const id = await stable[table]!.insert(tx);
      const message = await rejectionMessage(tx, (t) =>
        t.execute(sql`delete from ${sql.identifier(table)} where id = ${id}`),
      );
      expect(message).toMatch(new RegExp(`${table} rows are never deleted`));
    }),
  );

  it.each(Object.keys(stable))("%s: a core change writes exactly one history row, a non-core change none", (table) =>
    withRollback(async (tx) => {
      const { insert, coreChange, otherChange } = stable[table]!;
      const id = await insert(tx);
      const count = async () =>
        (await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from ${sql.identifier(`${table}_history`)} where row_id = ${id}`,
        )).rows[0]!.n;
      const update = (set: string) => tx.execute(sql`update ${sql.identifier(table)} set ${sql.raw(set)} where id = ${id}`);
      await update(otherChange);
      expect(await count()).toBe(0);
      await update(coreChange);
      expect(await count()).toBe(1);
    }),
  );

  it.each(Object.keys(stable))("%s_history rejects UPDATE and DELETE", (table) =>
    withRollback(async (tx) => {
      const { insert, coreChange } = stable[table]!;
      const id = await insert(tx);
      await tx.execute(sql`update ${sql.identifier(table)} set ${sql.raw(coreChange)} where id = ${id}`);
      const history = sql.identifier(`${table}_history`);
      expect(await rejectionMessage(tx, (t) => t.execute(sql`update ${history} set old_row = '{}'::jsonb`))).toMatch(
        /append-only|not allowed|forbid/i,
      );
      expect(await rejectionMessage(tx, (t) => t.execute(sql`delete from ${history}`))).toMatch(
        /append-only|not allowed|forbid/i,
      );
    }),
  );

  it("geo_objects history keeps the old tags and the old geom as GeoJSON", () =>
    withRollback(async (tx) => {
      const id = await insertGeoObject(tx);
      await tx.update(geoObjects).set({ tags: { natural: "bay" } }).where(eq(geoObjects.id, id));
      await tx.update(geoObjects).set({ geom: point(23.5, 37.5) }).where(eq(geoObjects.id, id));
      const history = await tx.execute<{ old_row: { geom: unknown; tags: unknown } }>(
        sql`select old_row from geo_objects_history where row_id = ${id}`,
      );
      expect(history.rows).toHaveLength(1);
      expect(history.rows[0]!.old_row.tags).toEqual({ natural: "bay" });
      expect(history.rows[0]!.old_row.geom).toMatchObject({ type: "Point", coordinates: [23.4, 37.4] });
    }));

  it("places.tile_id follows position, including a point exactly on a tile edge", () =>
    withRollback(async (tx) => {
      const id = await insertPlace(tx, 23.3, 37.3);
      const tileOf = async () =>
        (await tx.select({ tileId: places.tileId }).from(places).where(eq(places.id, id)))[0]!.tileId;
      expect(await tileOf()).toBe("q025:813:509");
      // position (23.25, 37.75) → "q025:813:511": an edge coordinate belongs to the tile east / north of it
      await tx.update(places).set({ position: point(23.25, 37.75) }).where(eq(places.id, id));
      expect(await tileOf()).toBe("q025:813:511");
    }));

  it("places.tile_id is always recomputed, a manual tile_id does not stick", () =>
    withRollback(async (tx) => {
      const id = await insertPlace(tx, 23.3, 37.3);
      await tx.update(places).set({ tileId: "x" }).where(eq(places.id, id));
      const [row] = await tx.select({ tileId: places.tileId }).from(places).where(eq(places.id, id));
      expect(row!.tileId).toBe("q025:813:509");
    }));

  it("updated_at is bumped on UPDATE for geo_objects and places", () =>
    withRollback(async (tx) => {
      const placeId = await insertPlace(tx, 23.3, 37.3);
      const [{ geoObjectId }] = await tx.select({ geoObjectId: places.geoObjectId }).from(places).where(eq(places.id, placeId));
      const stamp = (table: string, id: string) =>
        tx.execute<{ before: boolean }>(
          sql`select updated_at = created_at as before from ${sql.identifier(table)} where id = ${id}`,
        );
      expect((await stamp("geo_objects", geoObjectId)).rows[0]!.before).toBe(true);
      await tx.update(geoObjects).set({ tags: { a: "b" } }).where(eq(geoObjects.id, geoObjectId));
      await tx.update(places).set({ statusReason: "x" }).where(eq(places.id, placeId));
      expect((await stamp("geo_objects", geoObjectId)).rows[0]!.before).toBe(false);
      expect((await stamp("places", placeId)).rows[0]!.before).toBe(false);
    }));

  it("places has a GIST index on anchor_position", () =>
    withRollback(async (tx) => {
      const r = await tx.execute(sql`select 1 from pg_indexes where indexname = 'places_anchor_position_gist'`);
      expect(r.rows).toHaveLength(1);
    }));

  it("tile_id_for handles negative coordinates and tile edges", () =>
    withRollback(async (tx) => {
      const result = await tx.execute<{ a: string; b: string; c: string }>(sql`select
        tile_id_for(ST_SetSRID(ST_MakePoint(23.25, 37.75), 4326)) as a,
        tile_id_for(ST_SetSRID(ST_MakePoint(-0.1, -0.25), 4326)) as b,
        tile_id_for(ST_SetSRID(ST_MakePoint(-180, -90), 4326)) as c`);
      expect(result.rows[0]).toEqual({ a: "q025:813:511", b: "q025:719:359", c: "q025:0:0" });
    }));

  it("osm_id is unique only among valid rows", () =>
    withRollback(async (tx) => {
      const osmId = "node/424242";
      const first = await insertGeoObject(tx, { osmId });
      expect(await rejectionMessage(tx, (t) => insertGeoObject(t, { osmId }))).toMatch(/geo_objects_osm_id_valid_unique/);
      await tx.update(geoObjects).set({ validTo: "2026-01-01" }).where(eq(geoObjects.id, first));
      await expect(insertGeoObject(tx, { osmId })).resolves.toEqual(expect.any(String));
    }));

  it("centroid lies on the surface and geometries round-trip as GeoJSON", () =>
    withRollback(async (tx) => {
      // U-shaped bay: its plain centroid would fall into the notch, outside the polygon
      const id = await insertGeoObject(tx, {
        type: "area",
        geom: geomFromGeoJson({
          type: "Polygon",
          coordinates: [[[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3], [0, 0]]],
        }),
      });
      const [row] = await tx
        .select({
          geom: asGeoJson(geoObjects.geom),
          onSurface: sql<boolean>`ST_Intersects(${geoObjects.centroid}, ${geoObjects.geom})`,
        })
        .from(geoObjects)
        .where(eq(geoObjects.id, id));
      expect(row!.geom.type).toBe("Polygon");
      expect(row!.onSurface).toBe(true);
    }));
});
