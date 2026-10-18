import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, places, reviewTasks, type GeoObjectType } from "@/lib/db/schema";
import { findMatch, mergeGeoObjects, openPairTask } from "@/lib/domain/gazetteer/merge";
import { upsertGeoObject, type GeoObjectDraft } from "@/lib/domain/gazetteer/store";
import { withRollback } from "@/test/db";

const rules = getConfig().gazetteer.merge;

// Outside the pilot box 23.0-23.75 E x 37.0-38.0 N (north coast of Crete).
const LON = 25.1;
const LAT = 35.3;
const M_PER_DEG_LAT = 111_320;

/** A point `northM` metres north and `eastM` metres east of the base point. */
function offset(northM: number, eastM = 0): { lon: number; lat: number } {
  return {
    lon: LON + eastM / (M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180)),
    lat: LAT + northM / M_PER_DEG_LAT,
  };
}

async function insert(
  tx: Db,
  type: GeoObjectType,
  names: string[],
  geometry: GeoObjectDraft["geometry"],
  extra: Partial<GeoObjectDraft> = {},
): Promise<string> {
  const result = await upsertGeoObject(tx, {
    type,
    origin: "osm",
    geometry,
    names: names.map((name) => ({ name, language: "und", origin: "osm" })),
    ...extra,
  });
  if ("skipped" in result) throw new Error(result.skipped);
  return result.id;
}

function point(p: { lon: number; lat: number }): GeoJSON.Point {
  return { type: "Point", coordinates: [p.lon, p.lat] };
}

/** A square of `halfM` metres around the base point. */
function square(halfM: number): GeoJSON.Polygon {
  const sw = offset(-halfM, -halfM);
  const ne = offset(halfM, halfM);
  return {
    type: "Polygon",
    coordinates: [[[sw.lon, sw.lat], [ne.lon, sw.lat], [ne.lon, ne.lat], [sw.lon, ne.lat], [sw.lon, sw.lat]]],
  };
}

describe("findMatch", () => {
  it("same bay: 'Ormos Klima' vs 'Όρμος Κλήμα' 150 m apart → same", async () => {
    await withRollback(async (tx) => {
      const id = await insert(tx, "bay", ["Όρμος Κλήμα"], point(offset(0)));
      const match = await findMatch(tx, { type: "bay", point: offset(150), names: ["Ormos Klima"] }, rules);
      expect(match).toMatchObject({ kind: "same", id, similarity: 1 });
      if (match.kind === "none") throw new Error("unreachable");
      expect(match.distanceM).toBeGreaterThan(140);
      expect(match.distanceM).toBeLessThan(160);
    });
  });

  it("same name 450 m apart for a bay → uncertain (threshold 300, factor 2)", async () => {
    await withRollback(async (tx) => {
      const id = await insert(tx, "bay", ["Ormos Klima"], point(offset(0)));
      const match = await findMatch(tx, { type: "bay", point: offset(450), names: ["Ormos Klima"] }, rules);
      expect(match).toMatchObject({ kind: "uncertain", id, similarity: 1 });
      // Beyond d × factor (600 m) nothing matches.
      expect(await findMatch(tx, { type: "bay", point: offset(650), names: ["Ormos Klima"] }, rules)).toEqual({
        kind: "none",
      });
    });
  });

  it("similar name 0.6 within 300 m → uncertain", async () => {
    await withRollback(async (tx) => {
      const { rows } = await tx.execute<{ s: number }>(sql`select similarity('agia marina', 'agias marinas') as s`);
      const s = Number(rows[0]!.s);
      expect(s).toBeGreaterThanOrEqual(rules.uncertainTrigramMin);
      expect(s).toBeLessThan(rules.trigramMin);

      const id = await insert(tx, "bay", ["Agia Marina"], point(offset(0)));
      const match = await findMatch(tx, { type: "bay", point: offset(200), names: ["Agias Marinas"] }, rules);
      expect(match).toMatchObject({ kind: "uncertain", id });
      if (match.kind === "none") throw new Error("unreachable");
      expect(match.similarity).toBeCloseTo(s, 5);
      // Similar but not the same name and outside the distance: nothing.
      expect(await findMatch(tx, { type: "bay", point: offset(450), names: ["Agias Marinas"] }, rules)).toEqual({
        kind: "none",
      });
    });
  });

  it("different type (harbour vs bay) never matches", async () => {
    await withRollback(async (tx) => {
      await insert(tx, "bay", ["Ormos Klima"], point(offset(0)));
      expect(await findMatch(tx, { type: "harbour", point: offset(0), names: ["Ormos Klima"] }, rules)).toEqual({
        kind: "none",
      });
    });
  });

  it("island: point inside the island polygon with matching name → same", async () => {
    await withRollback(async (tx) => {
      const id = await insert(tx, "island", ["Νήσος Δία"], square(2000));
      // 1.5 km from the centre: far beyond d (500 m) from the centroid, but inside the polygon.
      const match = await findMatch(tx, { type: "island", point: offset(1500, 1500), names: ["Nisos Dia"] }, rules);
      expect(match).toMatchObject({ kind: "same", id, similarity: 1, distanceM: 0 });
      // 300 m off the coast: the polygon is not hit, the distance to it is within d × factor.
      expect(
        await findMatch(tx, { type: "island", point: offset(2300), names: ["Nisos Dia"] }, rules),
      ).toMatchObject({ kind: "uncertain", id });
    });
  });

  it("islet point matches an island polygon of the same name", async () => {
    await withRollback(async (tx) => {
      const id = await insert(tx, "island", ["Dia"], square(1000));
      const match = await findMatch(tx, { type: "islet", point: offset(800), names: ["Dia"] }, rules);
      expect(match).toMatchObject({ kind: "same", id });
      // And an island point matches an islet point within d.
      const islet = await insert(tx, "islet", ["Mikronisi"], point(offset(5000)));
      expect(
        await findMatch(tx, { type: "island", point: offset(5400), names: ["Mikronisi"] }, rules),
      ).toMatchObject({ kind: "same", id: islet });
    });
  });

  it("honours opts.distanceM and prefers the most similar, then the nearest candidate", async () => {
    await withRollback(async (tx) => {
      await insert(tx, "bay", ["Agia Marina"], point(offset(100)));
      const exact = await insert(tx, "bay", ["Agias Marinas"], point(offset(250)));
      const match = await findMatch(tx, { type: "bay", point: offset(0), names: ["Agias Marinas"] }, rules);
      expect(match).toMatchObject({ kind: "same", id: exact });

      const twin = await insert(tx, "bay", ["Agias Marinas"], point(offset(-200)));
      expect(
        await findMatch(tx, { type: "bay", point: offset(0), names: ["Agias Marinas"] }, rules),
      ).toMatchObject({ kind: "same", id: twin });

      // With a wider distance an item 900 m away is still the same object.
      const far = await insert(tx, "cape", ["Akrotiri Test"], point(offset(900)));
      const input = { type: "cape" as const, point: offset(0), names: ["Akrotiri Test"] };
      expect(await findMatch(tx, input, rules)).toMatchObject({ kind: "uncertain", id: far });
      expect(await findMatch(tx, input, rules, { distanceM: 1000 })).toMatchObject({ kind: "same", id: far });
    });
  });
});

async function validNames(tx: Db, geoObjectId: string) {
  return tx
    .select({ name: geoNames.name, language: geoNames.language, origin: geoNames.origin })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, geoObjectId), isNull(geoNames.validTo)))
    .orderBy(geoNames.name, geoNames.language, geoNames.origin);
}

async function insertPlace(tx: Db, geoObjectId: string): Promise<string> {
  const [row] = await tx
    .insert(places)
    .values({ geoObjectId, kind: "anchorage", position: geomFromGeoJson(point(offset(0))) })
    .returning({ id: places.id });
  return row!.id;
}

describe("mergeGeoObjects", () => {
  it("mergeGeoObjects moves names and children and ends the dropped object", async () => {
    await withRollback(async (tx) => {
      const keep = await insert(tx, "bay", ["Ormos Klima"], point(offset(0)), { osmId: "way/9100001" });
      const drop = await insert(tx, "bay", ["Όρμος Κλήμα"], point(offset(100)), {
        origin: "wikidata",
        wikidataId: "Q91000001",
        osmId: "way/9100002",
      });
      const child = await insert(tx, "poi", ["Taverna Klima"], point(offset(50)));
      await tx.update(geoObjects).set({ parentId: drop }).where(eq(geoObjects.id, child));
      const place = await insertPlace(tx, drop);

      await mergeGeoObjects(tx, keep, drop);

      expect(await validNames(tx, keep)).toEqual([
        { name: "Ormos Klima", language: "el", origin: "transliteration" },
        { name: "Ormos Klima", language: "und", origin: "osm" },
        { name: "Όρμος Κλήμα", language: "und", origin: "osm" },
      ]);
      expect(await validNames(tx, drop)).toEqual([]);

      const [k] = await tx.select().from(geoObjects).where(eq(geoObjects.id, keep));
      expect(k).toMatchObject({ osmId: "way/9100001", wikidataId: "Q91000001", validTo: null, mergedIntoId: null });
      const [d] = await tx.select().from(geoObjects).where(eq(geoObjects.id, drop));
      expect(d!.mergedIntoId).toBe(keep);
      expect(d!.validTo).not.toBeNull();
      const [c] = await tx.select().from(geoObjects).where(eq(geoObjects.id, child));
      expect(c!.parentId).toBe(keep);
      const [p] = await tx.select().from(places).where(eq(places.id, place));
      expect(p).toMatchObject({ geoObjectId: keep, status: "candidate", mergedIntoId: null });

      // The dropped object is no candidate any more.
      expect(
        await findMatch(tx, { type: "bay", point: offset(100), names: ["Όρμος Κλήμα"] }, rules),
      ).toMatchObject({ kind: "same", id: keep });
    });
  });

  it("rejects the dropped object's place in favour of the kept one's", async () => {
    await withRollback(async (tx) => {
      const keep = await insert(tx, "bay", ["Ormos Klima"], point(offset(0)));
      const drop = await insert(tx, "bay", ["Klima"], point(offset(100)));
      const keepPlace = await insertPlace(tx, keep);
      const dropPlace = await insertPlace(tx, drop);

      await mergeGeoObjects(tx, keep, drop);

      const [kp] = await tx.select().from(places).where(eq(places.id, keepPlace));
      expect(kp).toMatchObject({ geoObjectId: keep, status: "candidate", mergedIntoId: null });
      const [dp] = await tx.select().from(places).where(eq(places.id, dropPlace));
      expect(dp).toMatchObject({ geoObjectId: drop, status: "rejected", statusReason: "merged", mergedIntoId: keepPlace });
    });
  });

  it("refuses to merge an object into itself or an ended object", async () => {
    await withRollback(async (tx) => {
      const a = await insert(tx, "bay", ["Ormos A"], point(offset(0)));
      const b = await insert(tx, "bay", ["Ormos B"], point(offset(100)));
      const c = await insert(tx, "bay", ["Ormos C"], point(offset(200)));
      await expect(tx.transaction((t) => mergeGeoObjects(t, a, a))).rejects.toThrow(/itself/);
      await mergeGeoObjects(tx, a, b);
      await expect(tx.transaction((t) => mergeGeoObjects(t, c, b))).rejects.toThrow(/not valid/);
      await expect(tx.transaction((t) => mergeGeoObjects(t, b, c))).rejects.toThrow(/not valid/);
    });
  });
});

describe("openPairTask", () => {
  it("openPairTask is idempotent and respects a decided 'distinct'", async () => {
    await withRollback(async (tx) => {
      const a = await insert(tx, "bay", ["Ormos Klima"], point(offset(0)));
      const b = await insert(tx, "bay", ["Ormos Klima"], point(offset(450)));
      const subjectId = [a, b].sort().join(":");
      const context = { similarity: 1, distanceM: 450, source: "wikidata" as const };

      await openPairTask(tx, b, a, context);
      await openPairTask(tx, a, b, context);
      const tasks = await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, subjectId));
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        kind: "place_candidate",
        subjectType: "geo_object_pair",
        status: "open",
        context: { ...context, geoObjectIds: [a, b].sort() },
      });

      // A reviewer decided "distinct": the pair is never asked again.
      await tx.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.id, tasks[0]!.id));
      await openPairTask(tx, a, b, context);
      const after = await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, subjectId));
      expect(after).toHaveLength(1);
      expect(after[0]!.status).toBe("decided");
    });
  });
});
