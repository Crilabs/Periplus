import { readFileSync } from "node:fs";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, places, reviewTasks, type GeoObjectType } from "@/lib/db/schema";
import { AUTO_DECIDER, autoDecideOpenPairTasks, findMatch, mergeGeoObjects, openPairTask, resolveMergedByExternalId } from "@/lib/domain/gazetteer/merge";
import { upsertGeoObject, type GeoObjectDraft } from "@/lib/domain/gazetteer/store";
import { createReviewTask } from "@/lib/domain/review";
import { withRollback } from "@/test/db";
import { pairTaskOf } from "@/test/gazetteer";

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

  it("same name 450 m apart for a harbour → uncertain (threshold 300, factor 2)", async () => {
    await withRollback(async (tx) => {
      const id = await insert(tx, "harbour", ["Limani Klima"], point(offset(0)));
      const match = await findMatch(tx, { type: "harbour", point: offset(450), names: ["Limani Klima"] }, rules);
      expect(match).toMatchObject({ kind: "uncertain", id, similarity: 1 });
      // Beyond d × factor (600 m) nothing matches.
      expect(await findMatch(tx, { type: "harbour", point: offset(650), names: ["Limani Klima"] }, rules)).toEqual({
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

  it("bay names compare without generic bay words: the pilot pairs Ormos Valariou / Valariou Bay (731 m) and Ormos Taktikoupoleos / Taktikoupoleos Bay (1,045 m) are the same (B9)", async () => {
    await withRollback(async (tx) => {
      expect(rules.similarNameDistanceM.bay).toBe(1500);
      const valariou = await insert(tx, "bay", ["Ormos Valariou"], point(offset(0)));
      expect(await findMatch(tx, { type: "bay", point: offset(731), names: ["Valariou Bay"] }, rules)).toMatchObject({
        kind: "same",
        id: valariou,
        similarity: 1,
      });
      const taktikoupoleos = await insert(tx, "bay", ["Ormos Taktikoupoleos"], point(offset(5000)));
      expect(
        await findMatch(tx, { type: "bay", point: offset(5000 + 1045), names: ["Taktikoupoleos Bay"] }, rules),
      ).toMatchObject({ kind: "same", id: taktikoupoleos, similarity: 1 });
      // A Greek name through its transliteration: Όρμος → ormos is stripped as well.
      const greek = await insert(tx, "bay", ["Όρμος Βαλαρίου"], point(offset(10000)));
      expect(await findMatch(tx, { type: "bay", point: offset(10000 + 731), names: ["Valariou Bay"] }, rules)).toMatchObject({
        kind: "same",
        id: greek,
        similarity: 1,
      });
      // A name of generic words only keeps its unstripped form.
      const ormos = await insert(tx, "bay", ["Ormos"], point(offset(15000)));
      expect(await findMatch(tx, { type: "bay", point: offset(15000 + 100), names: ["Ormos"] }, rules)).toMatchObject({
        kind: "same",
        id: ormos,
        similarity: 1,
      });
    });
  });

  it("Ormos Agia Marina / Ormos Agia Anna 800 m apart are not the same and get no pair: the generic word carries no similarity", async () => {
    await withRollback(async (tx) => {
      const { rows } = await tx.execute<{ s: number }>(sql`select similarity('agia marina', 'agia anna') as s`);
      expect(Number(rows[0]!.s)).toBeLessThan(rules.uncertainTrigramMin);
      await insert(tx, "bay", ["Ormos Agia Marina"], point(offset(0)));
      expect(await findMatch(tx, { type: "bay", point: offset(800), names: ["Ormos Agia Anna"] }, rules)).toEqual({ kind: "none" });
      // Nor within the plain distance: with the shared word the names looked similar enough for a pair.
      expect(await findMatch(tx, { type: "bay", point: offset(200), names: ["Ormos Agia Anna"] }, rules)).toEqual({ kind: "none" });
    });
  });

  it("the uncertain band is not widened (max(D, d x factor)): 1,700 m is uncertain with the Wikidata link distance, none with the bay default", async () => {
    await withRollback(async (tx) => {
      const id = await insert(tx, "bay", ["Ormos Klima"], point(offset(0)));
      const input = (northM: number) => ({ type: "bay" as const, point: offset(northM), names: ["Ormos Klima"] });
      // d = 1,000 (wikidataLinkDistanceM), D = 1,500: uncertain up to 2,000 m
      expect(rules.wikidataLinkDistanceM).toBe(1000);
      const link = { distanceM: rules.wikidataLinkDistanceM };
      expect(await findMatch(tx, input(1700), rules, link)).toMatchObject({ kind: "uncertain", id });
      expect(await findMatch(tx, input(2100), rules, link)).toEqual({ kind: "none" });
      // d = 300 (bay default): D = 1,500 is the whole band
      expect(await findMatch(tx, input(1400), rules)).toMatchObject({ kind: "same", id });
      expect(await findMatch(tx, input(1700), rules)).toEqual({ kind: "none" });
      // An identical name 2,500 m away is nothing: no pair, so nothing merges it automatically.
      expect(await findMatch(tx, input(2500), rules)).toEqual({ kind: "none" });
    });
  });

  it("Ligea Bay (OSM) / Liyea Bay (Wikidata), a transliteration pair, is deliberately not merged: none at the measured 1,057 m, as today", async () => {
    await withRollback(async (tx) => {
      // Without the shared generic word the names lie below uncertainTrigramMin: no pair at any distance.
      const { rows } = await tx.execute<{ s: number }>(sql`select similarity('ligea', 'liyea') as s`);
      expect(Number(rows[0]!.s)).toBeLessThan(rules.uncertainTrigramMin);
      await insert(tx, "bay", ["Ligea Bay"], point(offset(0)));
      expect(await findMatch(tx, { type: "bay", point: offset(1057), names: ["Liyea Bay"] }, rules)).toEqual({ kind: "none" });
      expect(await findMatch(tx, { type: "bay", point: offset(200), names: ["Liyea Bay"] }, rules)).toEqual({ kind: "none" });
    });
  });

  it("a settlement 900 m away stays with today's rules (uncertain within d x factor)", async () => {
    await withRollback(async (tx) => {
      expect(rules.similarNameDistanceM.settlement).toBeUndefined();
      const id = await insert(tx, "settlement", ["Testchori"], point(offset(0)));
      expect(await findMatch(tx, { type: "settlement", point: offset(900), names: ["Testchori"] }, rules)).toMatchObject({
        kind: "uncertain",
        id,
      });
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

  it("dismisses the open tasks on the dropped place, which no decision could close any more (UI-5)", async () => {
    await withRollback(async (tx) => {
      const keep = await insert(tx, "bay", ["Ormos Klima"], point(offset(0)));
      const drop = await insert(tx, "bay", ["Klima"], point(offset(100)));
      const keepPlace = await insertPlace(tx, keep);
      const dropPlace = await insertPlace(tx, drop);
      const task = (subjectId: string) =>
        createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId, context: {} });
      const dropTask = await task(dropPlace);
      const keepTask = await task(keepPlace);

      await mergeGeoObjects(tx, keep, drop);

      const status = async (id: string) => (await tx.select().from(reviewTasks).where(eq(reviewTasks.id, id)))[0]!;
      expect(await status(dropTask.id)).toMatchObject({ status: "dismissed", context: { dismissedReason: "object_ended" } });
      expect((await status(keepTask.id)).status).toBe("open");
    });
  });

  it("the migration dismisses tasks a merge left open before, and only those (UI-5)", async () => {
    await withRollback(async (tx) => {
      const keep = await insert(tx, "bay", ["Ormos Klima"], point(offset(0)));
      const drop = await insert(tx, "bay", ["Klima"], point(offset(100)));
      const keepPlace = await insertPlace(tx, keep);
      const dropPlace = await insertPlace(tx, drop);
      await mergeGeoObjects(tx, keep, drop);
      // a task left open by an earlier merge, and an open task on the kept place
      const task = (subjectId: string) =>
        createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId, context: { name: "x" } });
      const stuck = await task(dropPlace);
      const live = await task(keepPlace);

      const migration = readFileSync("drizzle/0052_merged_place_tasks_dismiss.sql", "utf8");
      const scoped = migration.replace("WHERE t.status = 'open'", `WHERE t.id in ('${stuck.id}', '${live.id}') AND t.status = 'open'`);
      expect(scoped).not.toBe(migration);
      await tx.execute(sql.raw(scoped));

      const row = async (id: string) => (await tx.select().from(reviewTasks).where(eq(reviewTasks.id, id)))[0]!;
      expect(await row(stuck.id)).toMatchObject({ status: "dismissed", context: { name: "x", dismissedReason: "object_ended" } });
      expect((await row(live.id)).status).toBe("open");
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

describe("resolveMergedByExternalId", () => {
  it("follows the merged_into chain from an ended object to the surviving valid object", async () => {
    await withRollback(async (tx) => {
      const a = await insert(tx, "bay", ["Ormos A"], point(offset(0)), { wikidataId: "Q91000011" });
      const b = await insert(tx, "bay", ["Ormos B"], point(offset(100)), {
        wikidataId: "Q91000012",
        geonamesId: "91000012",
        osmId: "node/91000012",
      });
      const c = await insert(tx, "bay", ["Ormos C"], point(offset(200)), { wikidataId: "Q91000013" });

      // A valid object carrying the ID is no merged one.
      expect(await resolveMergedByExternalId(tx, "wikidata_id", "Q91000012")).toBeNull();
      expect(await resolveMergedByExternalId(tx, "wikidata_id", "Q91999999")).toBeNull();

      // b into a: a keeps its own QID, b's QID resolves to a.
      await mergeGeoObjects(tx, a, b);
      expect(await resolveMergedByExternalId(tx, "wikidata_id", "Q91000012")).toBe(a);

      // a into c: the chain b -> a -> c ends at c, for every external ID column.
      await mergeGeoObjects(tx, c, a);
      expect(await resolveMergedByExternalId(tx, "wikidata_id", "Q91000012")).toBe(c);
      expect(await resolveMergedByExternalId(tx, "wikidata_id", "Q91000011")).toBe(c);
      expect(await resolveMergedByExternalId(tx, "osm_id", "node/91000012")).toBe(c);
    });
  });

  it("returns null for an object ended without merge", async () => {
    await withRollback(async (tx) => {
      const a = await insert(tx, "bay", ["Ormos A"], point(offset(0)), { wikidataId: "Q91000021" });
      await tx.update(geoObjects).set({ validTo: sql`current_date` }).where(eq(geoObjects.id, a));
      expect(await resolveMergedByExternalId(tx, "wikidata_id", "Q91000021")).toBeNull();
    });
  });
});

describe("openPairTask", () => {
  it("openPairTask is idempotent and respects a decided 'distinct'", async () => {
    await withRollback(async (tx) => {
      // two OSM objects: a person decides
      const a = await insert(tx, "bay", ["Ormos Klima"], point(offset(0)), { osmId: "node/9170000001" });
      const b = await insert(tx, "bay", ["Ormos Klima"], point(offset(450)), { osmId: "node/9170000002" });
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

  const context = { similarity: 0.6, distanceM: 300, source: "wikidata" as const };
  const external = (tx: Db, names: string[], northM: number, origin: "wikidata" | "geonames" = "wikidata") =>
    insert(tx, "settlement", names, point(offset(northM)), { origin, names: names.map((name) => ({ name, language: "und", origin })) });

  it("an OSM object and an external one are decided 'same' by the system, the OSM object keeps", async () => {
    await withRollback(async (tx) => {
      const osm = await insert(tx, "settlement", ["Panorama"], point(offset(0)), { osmId: "node/9170000003" });
      const wd = await external(tx, ["Agia Paraskevi"], 300);
      expect(await openPairTask(tx, osm, wd, context)).toBe("same");
      expect(await pairTaskOf(tx, osm, wd)).toEqual({ status: "decided", action: "same", decidedBy: AUTO_DECIDER });
      const [dropped] = await tx.select({ mergedIntoId: geoObjects.mergedIntoId }).from(geoObjects).where(eq(geoObjects.id, wd));
      expect(dropped!.mergedIntoId).toBe(osm);
    });
  });

  it("two external objects are 'same' from trigramMin on and 'distinct' below", async () => {
    await withRollback(async (tx) => {
      const a = await external(tx, ["Prasonisi"], 0);
      const b = await external(tx, ["Prasonisi"], 50, "geonames");
      expect(await openPairTask(tx, a, b, { ...context, similarity: rules.trigramMin })).toBe("same");
      const c = await external(tx, ["Megali Kyra"], 1000);
      const d = await external(tx, ["Mikri Kyra"], 1400);
      expect(await openPairTask(tx, c, d, { ...context, similarity: rules.trigramMin - 0.01 })).toBe("distinct");
      expect(await pairTaskOf(tx, c, d)).toEqual({ status: "decided", action: "distinct", decidedBy: AUTO_DECIDER });
      const valid = await tx.select({ id: geoObjects.id }).from(geoObjects).where(and(inArray(geoObjects.id, [c, d]), isNull(geoObjects.mergedIntoId)));
      expect(valid).toHaveLength(2);
    });
  });

  it("a pair whose object carries a place, and a highlight pair, stay with a person", async () => {
    await withRollback(async (tx) => {
      const objectId = await insert(tx, "bay", ["Klima"], point(offset(0)), { osmId: "node/9170000005" });
      await insertPlace(tx, objectId);
      const wd = await insert(tx, "bay", ["Klima"], point(offset(200)), { origin: "wikidata", names: [{ name: "Klima", language: "und", origin: "wikidata" }] });
      expect(await openPairTask(tx, objectId, wd, context)).toBeNull();
      expect(await pairTaskOf(tx, objectId, wd)).toMatchObject({ status: "open" });

      const osm = await insert(tx, "poi", ["Kritikos"], point(offset(2000)), { osmId: "node/9170000004", category: "culture" });
      const ext = await insert(tx, "poi", ["Kritikos"], point(offset(2100)), { origin: "wikidata", category: "culture", names: [{ name: "Kritikos", language: "und", origin: "wikidata" }] });
      expect(await openPairTask(tx, osm, ext, { ...context, source: "computed" })).toBeNull();
      expect(await pairTaskOf(tx, osm, ext)).toMatchObject({ status: "open" });
    });
  });
});

describe("autoDecideOpenPairTasks", () => {
  it("decides the open pair tasks the rule knows, dismisses those whose object ended, leaves the others open", async () => {
    await withRollback(async (tx) => {
      const external = (names: string[], northM: number) =>
        insert(tx, "bay", names, point(offset(northM)), { origin: "wikidata", names: names.map((name) => ({ name, language: "und", origin: "wikidata" })) });
      const osm = await insert(tx, "bay", ["Panorama"], point(offset(0)), { osmId: "node/9170000010" });
      const wd = await external(["Agia Paraskevi"], 300);
      const wd2 = await external(["Epano Epidavros"], 600);
      const [osmA, osmB] = [
        await insert(tx, "bay", ["Kalami"], point(offset(5000)), { osmId: "node/9170000011" }),
        await insert(tx, "bay", ["Kalamaki"], point(offset(5200)), { osmId: "node/9170000012" }),
      ];
      // tasks opened before the rule existed
      const open = (a: string, b: string, similarity: number) =>
        createReviewTask(tx, {
          kind: "place_candidate",
          subjectType: "geo_object_pair",
          subjectId: [a, b].sort().join(":"),
          context: { similarity, distanceM: 300, source: "wikidata", geoObjectIds: [a, b].sort() },
        });
      await open(osm, wd, 0.53);
      await open(wd, wd2, 0.9);
      await open(osmA, osmB, 0.7);

      const result = await autoDecideOpenPairTasks(tx, rules);
      // a bay takes facts: the survivor is consolidated
      expect(result).toEqual({ same: 1, distinct: 0, dismissed: 1, open: 1, kept: [osm] });
      expect(await pairTaskOf(tx, osm, wd)).toEqual({ status: "decided", action: "same", decidedBy: AUTO_DECIDER });
      expect(await pairTaskOf(tx, wd, wd2)).toEqual({ status: "dismissed", action: null, decidedBy: null });
      expect(await pairTaskOf(tx, osmA, osmB)).toEqual({ status: "open", action: null, decidedBy: null });
    });
  });
});

