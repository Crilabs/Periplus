import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  geoNames,
  geoObjects,
  landPolygons,
  places,
  restrictedAreas,
  reviewTasks,
  tileGeoObjects,
  tiles,
  type GeoObjectType,
  type PlaceKind,
  type RestrictedKind,
} from "@/lib/db/schema";
import { placeKindFromTags, seedTile } from "@/lib/domain/seed";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { startWhileLocked, testDb, withRollback } from "@/test/db";

// Synthetic data in open sea outside the pilot box 23.0-23.75 E x 37.0-38.0 N: tiles T1 (27.00-27.25 E)
// and its eastern neighbour T2 (27.25-27.50 E), both 34.00-34.25 N.
const T1 = tileIdFor(27.1, 34.1);
const T2 = tileIdFor(27.3, 34.1);

type Polygon = { type: "Polygon"; coordinates: [number, number][][] };
const box = (w: number, s: number, e: number, n: number): Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});
const point = (lon: number, lat: number): GeoJSON.Point => ({ type: "Point", coordinates: [lon, lat] });

const cfg = () => getConfig().gazetteer;

async function ensureTile(db: Db, tileId: string): Promise<void> {
  const [w, s, e, n] = tileBbox(tileId);
  await db
    .insert(tiles)
    .values({ id: tileId, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, hasCoast: true })
    .onConflictDoNothing();
}

type ObjectInput = {
  type: GeoObjectType;
  geometry: GeoJSON.Geometry;
  tags?: Record<string, string>;
  tileIds?: string[];
  mergedIntoId?: string;
  ended?: boolean;
};

async function insertObject(db: Db, o: ObjectInput): Promise<string> {
  const [row] = await db
    .insert(geoObjects)
    .values({
      type: o.type,
      origin: "osm",
      geom: sql`${geomFromGeoJson(o.geometry)}`,
      tags: o.tags ?? {},
      mergedIntoId: o.mergedIntoId,
      ...(o.ended ? { validFrom: "2020-01-01", validTo: "2021-01-01" } : {}),
    })
    .returning({ id: geoObjects.id });
  for (const tileId of o.tileIds ?? [T1]) {
    await ensureTile(db, tileId);
    await db.insert(tileGeoObjects).values({ tileId, geoObjectId: row!.id });
  }
  return row!.id;
}

async function placeOf(db: Db, geoObjectId: string) {
  const [row] = await db
    .select({
      id: places.id,
      kind: places.kind,
      status: places.status,
      statusReason: places.statusReason,
      tileId: places.tileId,
    })
    .from(places)
    .where(eq(places.geoObjectId, geoObjectId));
  return row;
}

async function tasksFor(db: Db, placeIds: string[]) {
  return db
    .select({ subjectType: reviewTasks.subjectType, subjectId: reviewTasks.subjectId, context: reviewTasks.context })
    .from(reviewTasks)
    .where(and(eq(reviewTasks.kind, "place_candidate"), inArray(reviewTasks.subjectId, placeIds)));
}

async function insertRestricted(
  db: Db,
  kind: RestrictedKind,
  geometry: GeoJSON.Geometry,
  sourceRef: string | null = null,
): Promise<string> {
  const [row] = await db
    .insert(restrictedAreas)
    .values({ kind, geom: sql`${geomFromGeoJson(geometry)}`, sourceRef })
    .returning({ id: restrictedAreas.id });
  return row!.id;
}

describe("placeKindFromTags", () => {
  it.each<[GeoObjectType, Record<string, string>, PlaceKind]>([
    ["harbour", { leisure: "marina" }, "marina"],
    ["poi", { "seamark:type": "small_craft_facility" }, "marina"],
    ["bay", { "seamark:type": "mooring" }, "mooring_field"],
    ["poi", { mooring: "yes" }, "mooring_field"],
    ["harbour", {}, "port"],
    ["poi", { "seamark:type": "harbour" }, "port"],
    ["bay", {}, "anchorage"],
    ["poi", { "seamark:type": "anchorage" }, "anchorage"],
  ])("%s %o → %s", (type, tags, kind) => {
    expect(placeKindFromTags(type, tags)).toBe(kind);
  });
});

describe("seedTile", () => {
  it("creates one candidate per bay/harbour with a review task", () =>
    withRollback(async (db) => {
      const bay = await insertObject(db, { type: "bay", geometry: point(27.1, 34.1) });
      const harbour = await insertObject(db, { type: "harbour", geometry: point(27.11, 34.11) });
      const marina = await insertObject(db, { type: "poi", geometry: point(27.12, 34.12), tags: { leisure: "marina" } });
      const mooring = await insertObject(db, {
        type: "poi",
        geometry: point(27.13, 34.13),
        tags: { "seamark:type": "mooring" },
      });
      // Not candidates: other types, merged or ended objects.
      await insertObject(db, { type: "settlement", geometry: point(27.14, 34.14) });
      await insertObject(db, { type: "poi", geometry: point(27.15, 34.15), tags: { amenity: "cafe" } });
      await insertObject(db, { type: "bay", geometry: point(27.16, 34.16), mergedIntoId: bay });
      await insertObject(db, { type: "bay", geometry: point(27.17, 34.17), ended: true });
      await db.insert(geoNames).values([
        { geoObjectId: bay, name: "Bay", nameNormalized: "bay", language: "en", script: "latin", origin: "osm" },
        { geoObjectId: bay, name: "Bucht", nameNormalized: "bucht", language: "de", script: "latin", origin: "osm" },
      ]);

      const result = await seedTile(db, T1, cfg());
      expect(result).toEqual({ created: 4, existing: 0, skippedOtherTile: 0, noAnchoring: 0 });

      const rows: Awaited<ReturnType<typeof placeOf>>[] = [];
      for (const id of [bay, harbour, marina, mooring]) rows.push(await placeOf(db, id));
      expect(rows.map((r) => [r?.kind, r?.status, r?.tileId])).toEqual([
        ["anchorage", "candidate", T1],
        ["port", "candidate", T1],
        ["marina", "candidate", T1],
        ["mooring_field", "candidate", T1],
      ]);
      const { rows: positions } = await db.execute<{ x: number; y: number }>(
        sql`select ST_X(position) as x, ST_Y(position) as y from places where geo_object_id = ${bay}`,
      );
      expect(positions[0]).toEqual({ x: 27.1, y: 34.1 });

      const tasks = await tasksFor(db, rows.map((r) => r!.id));
      expect(tasks).toHaveLength(4);
      expect(tasks.find((t) => t.subjectId === rows[0]!.id)).toEqual({
        subjectType: "place",
        subjectId: rows[0]!.id,
        context: { geoObjectId: bay, kind: "anchorage", tileId: T1, name: "Bucht" },
      });
      expect(tasks.find((t) => t.subjectId === rows[1]!.id)?.context).toMatchObject({ name: null });
    }));

  it("waits for a running bay detection (its advisory lock), so the detection never misses a place being seeded (CON-4)", async () => {
    await expect(
      startWhileLocked(testDb(), "geometry.detect_bays", async (db) => {
        await insertObject(db, { type: "bay", geometry: point(27.1, 34.1) });
        return seedTile(db, T1, cfg());
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "55P03" }) });
  });

  it("bay spanning two tiles yields one place, in the tile of its position", () =>
    withRollback(async (db) => {
      // Centroid at 27.21 E: in T1.
      const bay = await insertObject(db, { type: "bay", geometry: box(27.15, 34.1, 27.27, 34.15), tileIds: [T1, T2] });

      expect(await seedTile(db, T2, cfg())).toEqual({ created: 0, existing: 0, skippedOtherTile: 1, noAnchoring: 0 });
      expect(await seedTile(db, T1, cfg())).toEqual({ created: 1, existing: 0, skippedOtherTile: 0, noAnchoring: 0 });
      expect(await seedTile(db, T2, cfg())).toEqual({ created: 0, existing: 0, skippedOtherTile: 1, noAnchoring: 0 });

      const rows = await db.select({ tileId: places.tileId }).from(places).where(eq(places.geoObjectId, bay));
      expect(rows).toEqual([{ tileId: T1 }]);
    }));

  it("position of a concave bay polygon lies in water", () =>
    withRollback(async (db) => {
      // A peninsula reaches from the south into the middle of the bay; the water is U-shaped and its
      // centroid (27.10, ~34.106) lies on the peninsula.
      const bayGeom = box(27.05, 34.05, 27.15, 34.15);
      const land = box(27.08, 34.0, 27.12, 34.12);
      await db.insert(landPolygons).values({ geom: sql`${geomFromGeoJson(land)}`, datasetVersion: "test" });
      const bay = await insertObject(db, { type: "bay", geometry: bayGeom });

      expect(await seedTile(db, T1, cfg())).toMatchObject({ created: 1 });
      const { rows } = await db.execute<{ inWater: boolean; centroidOnLand: boolean }>(sql`
        select
          ST_Within(p.position, ST_Difference(${geomFromGeoJson(bayGeom)}, ${geomFromGeoJson(land)})) as "inWater",
          ST_Within(ST_Centroid(ST_Difference(${geomFromGeoJson(bayGeom)}, ${geomFromGeoJson(land)})),
            ${geomFromGeoJson(land)}) as "centroidOnLand"
        from places p where p.geo_object_id = ${bay}`);
      expect(rows[0]).toEqual({ inWater: true, centroidOnLand: true });
    }));

  it("a bay polygon entirely on land keeps a point on its surface", () =>
    withRollback(async (db) => {
      const bayGeom = box(27.05, 34.05, 27.1, 34.1);
      await db.insert(landPolygons).values({ geom: sql`${geomFromGeoJson(box(27.0, 34.0, 27.2, 34.2))}`, datasetVersion: "test" });
      const bay = await insertObject(db, { type: "bay", geometry: bayGeom });

      expect(await seedTile(db, T1, cfg())).toMatchObject({ created: 1 });
      const { rows } = await db.execute<{ within: boolean }>(
        sql`select ST_Within(position, ${geomFromGeoJson(bayGeom)}) as within from places where geo_object_id = ${bay}`,
      );
      expect(rows[0]).toEqual({ within: true });
    }));

  it("a candidate inside a military restricted area becomes no_anchoring without a review task", () =>
    withRollback(async (db) => {
      const military = await insertRestricted(db, "military", box(27.0, 34.0, 27.05, 34.05));
      await insertRestricted(db, "protected_area", box(27.05, 34.05, 27.1, 34.1));
      const blocked = await insertObject(db, { type: "bay", geometry: point(27.02, 34.02) });
      const protectedBay = await insertObject(db, { type: "bay", geometry: point(27.07, 34.07) });

      expect(await seedTile(db, T1, cfg())).toEqual({ created: 2, existing: 0, skippedOtherTile: 0, noAnchoring: 1 });

      const blockedPlace = await placeOf(db, blocked);
      expect(blockedPlace).toMatchObject({ status: "no_anchoring", statusReason: `restricted:military:${military}` });
      const protectedPlace = await placeOf(db, protectedBay);
      expect(protectedPlace).toMatchObject({ status: "candidate", statusReason: null });
      const tasks = await tasksFor(db, [blockedPlace!.id, protectedPlace!.id]);
      expect(tasks.map((t) => t.subjectId)).toEqual([protectedPlace!.id]);
    }));

  it("a new place inside a configured protected area becomes no_anchoring", () =>
    withRollback(async (db) => {
      const banned = await insertRestricted(db, "protected_area", box(27.0, 34.0, 27.05, 34.05), "natura2000/GR4210001");
      await insertRestricted(db, "protected_area", box(27.05, 34.05, 27.1, 34.1), "natura2000/GR4210002");
      const inBanned = await insertObject(db, { type: "bay", geometry: point(27.02, 34.02) });
      const inOther = await insertObject(db, { type: "bay", geometry: point(27.07, 34.07) });

      const opts = { restrictions: { protectedAreaAnchoringBan: ["GR4210001"] }, minShare: 0.5 };
      expect(await seedTile(db, T1, cfg(), opts)).toEqual({
        created: 2,
        existing: 0,
        skippedOtherTile: 0,
        noAnchoring: 1,
      });
      expect(await placeOf(db, inBanned)).toMatchObject({
        status: "no_anchoring",
        statusReason: `restricted:protected_area:${banned}`,
      });
      expect(await placeOf(db, inOther)).toMatchObject({ status: "candidate", statusReason: null });
    }));

  it("second run creates no places or tasks and keeps a confirmed status", () =>
    withRollback(async (db) => {
      const a = await insertObject(db, { type: "bay", geometry: point(27.1, 34.1) });
      const b = await insertObject(db, { type: "harbour", geometry: point(27.2, 34.2) });
      expect(await seedTile(db, T1, cfg())).toMatchObject({ created: 2 });
      const placeA = await placeOf(db, a);
      const placeB = await placeOf(db, b);
      await db.update(places).set({ status: "confirmed" }).where(eq(places.id, placeA!.id));
      // A restricted area appearing later does not touch existing places.
      await insertRestricted(db, "military", box(27.0, 34.0, 27.25, 34.25));

      expect(await seedTile(db, T1, cfg())).toEqual({ created: 0, existing: 2, skippedOtherTile: 0, noAnchoring: 0 });
      expect(await placeOf(db, a)).toMatchObject({ status: "confirmed", statusReason: null });
      expect(await placeOf(db, b)).toMatchObject({ status: "candidate", statusReason: null });
      const count = await db.$count(places, inArray(places.geoObjectId, [a, b]));
      expect(count).toBe(2);
      expect(await tasksFor(db, [placeA!.id, placeB!.id])).toHaveLength(2);
    }));
});
