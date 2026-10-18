import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { GeonamesAltName, GeonamesRow, GeonamesSource } from "@/lib/adapters/geonames";
import type { AreaConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoNames, geoObjects, reviewTasks } from "@/lib/db/schema";
import { mergeGeoObjects } from "@/lib/domain/gazetteer/merge";
import { newId } from "@/lib/domain/ids";
import { upsertGeoObject, type GeoObjectDraft } from "@/lib/domain/gazetteer/store";
import type { Bbox } from "@/lib/domain/tiles";
import { importGeonames } from "@/lib/pipeline/gazetteer/geonames";
import { withRollback } from "@/test/db";
import { createdInThisTransaction, pairTasksOf } from "@/test/gazetteer";

// Synthetic area outside the pilot box 23.0-23.75 E x 37.0-38.0 N.
function area(): AreaConfig {
  return {
    key: "geonames-test",
    names: { de: "Testrevier", en: "Test area" },
    polygon: { type: "Polygon", coordinates: [[[26.0, 35.6], [26.4, 35.6], [26.4, 35.9], [26.0, 35.9], [26.0, 35.6]]] },
    tileBbox: null,
    sourceLanguages: ["de", "en", "el"],
    season: { fromMonth: 4, toMonth: 10 },
    cycleDays: 30,
    coastSections: [],
  };
}

const ID = 9_150_000_000;
const gn = (n: number) => String(ID + n);
const osm = (type: string, n: number) => `${type}/${ID + n}`;

function row(n: number, featureCode: string, lon: number, lat: number, name: string, asciiName = name): GeonamesRow {
  return { id: gn(n), name, asciiName, lat, lon, featureClass: featureCode === "BAY" ? "H" : "T", featureCode, country: "GR" };
}

function alt(n: number, language: string, name: string, isPreferred = false): GeonamesAltName {
  return { geonameId: gn(n), language, name, isPreferred, isHistoric: false };
}

// Metres per degree at 35.75 N: latitude ~110,950, longitude ~90,100.
const ROWS = {
  // ~180 m east of the OSM bay with the same name.
  bay: row(1, "BAY", 26.202, 35.75, "Kalm Bay"),
  // ~270 m east of the OSM bay, unrelated name.
  otherBay: row(2, "BAY", 26.203, 35.75, "Ormos Xenos"),
  // A cape far from any object, Greek main name.
  cape: row(3, "CAPE", 26.3, 35.8, "Ακρωτήριο Δοκιμή", "Akrotirio Dokimi"),
  // A cape ~700 m north of the OSM cape, same name: beyond 500 m, within the uncertain band (up to 1000 m).
  nearCape: row(4, "CAPE", 26.35, 35.6563, "Akrotiri Kavos"),
  // A feature code that is not configured: ignored.
  hotel: row(5, "HTL", 26.1, 35.85, "Test Hotel"),
};

const ALT_NAMES: GeonamesAltName[] = [
  alt(1, "el", "Όρμος Καλμ", true),
  alt(1, "de", "Kalmbucht"),
  alt(1, "en", "Kalm Bay"),
  alt(2, "de", "Fremdbucht"),
  alt(3, "de", "Kap Dokimi"),
  alt(3, "", "Capo Dokimi"),
];

const OSM_OBJECTS: GeoObjectDraft[] = [
  {
    type: "bay",
    origin: "osm",
    osmId: osm("node", 1),
    tags: { natural: "bay" },
    geometry: { type: "Point", coordinates: [26.2, 35.75] },
    names: [{ name: "Kalm Bay", language: "en", origin: "osm" }],
  },
  {
    type: "cape",
    origin: "osm",
    osmId: osm("node", 4),
    tags: { natural: "cape" },
    geometry: { type: "Point", coordinates: [26.35, 35.65] },
    names: [{ name: "Akrotiri Kavos", language: "en", origin: "osm" }],
  },
];

/** In-memory GeoNames source; records the requested countries and boxes. */
function source(rows: GeonamesRow[], seen: { country: string; bbox: Bbox }[] = []): GeonamesSource {
  return {
    async rows(country, bbox) {
      seen.push({ country, bbox });
      const [w, s, e, n] = bbox;
      return rows.filter((r) => r.country === country && r.lon >= w && r.lon < e && r.lat >= s && r.lat < n);
    },
    async alternateNames(_country, ids) {
      return ALT_NAMES.filter((a) => ids.has(a.geonameId));
    },
  };
}

async function prepare(db: Db): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const draft of OSM_OBJECTS) {
    const r = await upsertGeoObject(db, draft);
    if ("skipped" in r) throw new Error(r.skipped);
    ids[draft.osmId!] = r.id;
  }
  return ids;
}

async function byGeonames(db: Db, id: string) {
  return db
    .select({ id: geoObjects.id, osmId: geoObjects.osmId, type: geoObjects.type, origin: geoObjects.origin })
    .from(geoObjects)
    .where(and(eq(geoObjects.geonamesId, id), isNull(geoObjects.validTo)));
}

async function names(db: Db, geoObjectId: string) {
  return db
    .select({ name: geoNames.name, language: geoNames.language, origin: geoNames.origin, isPreferred: geoNames.isPreferred })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, geoObjectId), isNull(geoNames.validTo)));
}

const run = (db: Db, rows: GeonamesRow[] = Object.values(ROWS), seen?: { country: string; bbox: Bbox }[]) =>
  importGeonames(db, { area: area(), runId: newId() }, { source: source(rows, seen) });

describe("importGeonames", () => {
  it("adds Greek and German alternate names to the matching OSM bay", () =>
    withRollback(async (db) => {
      const ids = await prepare(db);
      const seen: { country: string; bbox: Bbox }[] = [];
      const result = await run(db, [ROWS.bay], seen);
      // Kalm Bay (und), Όρμος Καλμ (el) + transliteration, Kalmbucht (de), Kalm Bay (en, geonames).
      expect(result).toEqual({ linked: 1, created: 0, skipped: 0, uncertain: 0, names: 5 });

      const [bay] = await byGeonames(db, gn(1));
      expect(bay).toMatchObject({ id: ids[osm("node", 1)], type: "bay", origin: "osm" });
      const rows = await names(db, bay!.id);
      expect(rows).toEqual(
        expect.arrayContaining([
          { name: "Kalm Bay", language: "en", origin: "osm", isPreferred: true },
          { name: "Όρμος Καλμ", language: "el", origin: "geonames", isPreferred: true },
          { name: "Ormos Kalm", language: "el", origin: "transliteration", isPreferred: false },
          { name: "Kalmbucht", language: "de", origin: "geonames", isPreferred: true },
          { name: "Kalm Bay", language: "und", origin: "geonames", isPreferred: true },
          { name: "Kalm Bay", language: "en", origin: "geonames", isPreferred: false },
        ]),
      );
      // The ASCII name is not added as a second `en` name: an `en` alternate name exists.
      expect(rows.filter((r) => r.language === "en" && r.origin === "geonames")).toHaveLength(1);

      // One read per configured country, for the area box plus 5 km.
      expect(seen.map((s) => s.country)).toEqual(["GR"]);
      expect(seen[0]!.bbox[1]).toBeCloseTo(35.6 - 5 / 111.32, 6);
    }));

  it("skips an unmatched bay within 500 m of another bay", () =>
    withRollback(async (db) => {
      await prepare(db);
      const result = await run(db, [ROWS.otherBay]);
      expect(result).toEqual({ linked: 0, created: 0, skipped: 1, uncertain: 0, names: 0 });
      expect(await byGeonames(db, gn(2))).toEqual([]);
    }));

  it("creates a cape that OSM lacks", () =>
    withRollback(async (db) => {
      await prepare(db);
      const result = await run(db, [ROWS.cape, ROWS.hotel]);
      expect(result).toMatchObject({ linked: 0, created: 1, skipped: 0 });
      const [cape] = await byGeonames(db, gn(3));
      expect(cape).toMatchObject({ type: "cape", origin: "geonames", osmId: null });
      const { rows: geom } = await db.execute<{ t: string; lon: number; lat: number }>(
        sql`select ST_GeometryType(geom) as t, ST_X(geom) as lon, ST_Y(geom) as lat from geo_objects where id = ${cape!.id}`,
      );
      expect(geom[0]).toEqual({ t: "ST_Point", lon: 26.3, lat: 35.8 });
      const rows = await names(db, cape!.id);
      expect(rows).toEqual(
        expect.arrayContaining([
          { name: "Ακρωτήριο Δοκιμή", language: "el", origin: "geonames", isPreferred: true },
          { name: "Akrotirio Dokimi", language: "el", origin: "transliteration", isPreferred: false },
          { name: "Akrotirio Dokimi", language: "en", origin: "geonames", isPreferred: true },
          { name: "Kap Dokimi", language: "de", origin: "geonames", isPreferred: true },
          { name: "Capo Dokimi", language: "und", origin: "geonames", isPreferred: true },
        ]),
      );
      expect(result.names).toBe(rows.length);
      expect(await byGeonames(db, gn(5))).toEqual([]);
    }));

  it("a cape merged into an object with another GeoNames ID links to the survivor on the next run", () =>
    withRollback(async (db) => {
      const ids = await prepare(db);
      const osmCape = ids[osm("node", 4)]!;
      await db.update(geoObjects).set({ geonamesId: gn(6) }).where(eq(geoObjects.id, osmCape));

      expect(await run(db, [ROWS.nearCape])).toMatchObject({ created: 1, skipped: 0 });
      const [cape] = await byGeonames(db, gn(4));
      // A reviewer decided "same": the GeoNames cape is merged into the OSM cape, which keeps its own ID.
      await mergeGeoObjects(db, osmCape, cape!.id);
      expect(await byGeonames(db, gn(4))).toEqual([]);

      const capes = async () =>
        (await db.select({ id: geoObjects.id }).from(geoObjects).where(and(eq(geoObjects.type, "cape"), createdInThisTransaction)))
          .length;
      const before = await capes();
      const second = await run(db, [ROWS.nearCape]);
      expect(second).toEqual({ linked: 1, created: 0, skipped: 0, uncertain: 0, names: 0 });
      expect(await capes()).toBe(before);
      expect(await names(db, osmCape)).toEqual(
        expect.arrayContaining([{ name: "Akrotiri Kavos", language: "und", origin: "geonames", isPreferred: true }]),
      );
    }));

  it("an uncertain match that ends as a new cape opens one pair task", () =>
    withRollback(async (db) => {
      const ids = await prepare(db);
      const result = await run(db, [ROWS.nearCape]);
      expect(result).toMatchObject({ linked: 0, created: 1, skipped: 0, uncertain: 1 });
      const [cape] = await byGeonames(db, gn(4));
      const subjectId = [cape!.id, ids[osm("node", 4)]!].sort().join(":");
      const tasks = await db.select().from(reviewTasks).where(eq(reviewTasks.subjectId, subjectId));
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ kind: "place_candidate", subjectType: "geo_object_pair", status: "open" });
      expect(tasks[0]!.context).toMatchObject({ source: "geonames", similarity: 1 });
      const distanceM = (tasks[0]!.context as { distanceM: number }).distanceM;
      expect(distanceM).toBeGreaterThan(500);
      expect(distanceM).toBeLessThan(1000);
    }));

  it("second run changes nothing", () =>
    withRollback(async (db) => {
      const ids = await prepare(db);
      const first = await run(db);
      expect(first).toMatchObject({ linked: 1, created: 2, skipped: 1 });
      const gids = [1, 2, 3, 4, 5].map(gn);
      const scope = or(inArray(geoObjects.geonamesId, gids), inArray(geoObjects.id, Object.values(ids)));
      const objects = await db.select({ id: geoObjects.id }).from(geoObjects).where(scope);
      const objectIds = objects.map((o) => o.id);
      const historyCount = async (table: "geo_objects_history" | "geo_names_history") => {
        const { rows } = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from ${sql.identifier(table)} where row_id in ${objectIds}`,
        );
        return rows[0]!.n;
      };
      const snapshot = async () => ({
        objects: await db
          .select({ id: geoObjects.id, geonamesId: geoObjects.geonamesId })
          .from(geoObjects)
          .where(scope)
          .orderBy(geoObjects.id),
        tasks: (await pairTasksOf(db, objectIds)).length,
        objectHistory: await historyCount("geo_objects_history"),
        names: await db
          .select({ id: geoNames.id, validTo: geoNames.validTo, isPreferred: geoNames.isPreferred })
          .from(geoNames)
          .where(inArray(geoNames.geoObjectId, objectIds))
          .orderBy(geoNames.id),
      });
      const before = await snapshot();
      expect(before.tasks).toBe(1);
      expect(before.objects.map((o) => o.geonamesId).sort()).toEqual([gn(1), gn(3), gn(4), null].sort());
      const second = await run(db);
      expect(second).toEqual({ linked: 0, created: 0, skipped: 1, uncertain: 0, names: 0 });
      expect(await snapshot()).toEqual(before);
    }));
});
