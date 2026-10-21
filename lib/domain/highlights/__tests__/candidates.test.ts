import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getConsolidationConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { facts, geoObjects, mentions, places, wikidataSitelinks } from "@/lib/db/schema";
import type { PoiCategory } from "@/lib/db/schema/geo";
import { importanceOf } from "@/lib/domain/consolidation/derived/importance";
import { testDb, withRollback } from "@/test/db";
import { insertExtraction, insertMention, insertMentionFact, insertPlace, insertSource, type TestMention } from "@/test/consolidation";
import { insertNamedObject } from "@/test/text";
import { loadHighlightCandidates, poiKinds } from "../candidates";

/*
 * The candidate loader of a place's highlights (spec 16), inside withRollback around 21.4° E / 35.6° N (outside the
 * pilot box). Other tests may commit POIs nearby, so assertions look at the test's own ids only.
 */

const cfg = getConsolidationConfig();
let today = "";
beforeAll(async () => {
  const { rows } = await testDb().execute<{ today: string }>(sql`select current_date::text as today`);
  today = rows[0]!.today;
});

const LON = 21.4;
const LAT = 35.6;
/** Degrees of latitude per km (meridian, near 35.6° N). */
const LAT_PER_KM = 1 / 110.96;

async function poi(
  tx: Db,
  name: string,
  category: PoiCategory | null,
  km: number,
  o: { tags?: Record<string, unknown>; wikidataId?: string } = {},
): Promise<string> {
  const id = await insertNamedObject(tx, { type: "poi", category, names: [{ name }], lon: LON, lat: LAT + km * LAT_PER_KM });
  if (o.tags || o.wikidataId) {
    await tx.update(geoObjects).set({ tags: o.tags ?? {}, wikidataId: o.wikidataId ?? null }).where(eq(geoObjects.id, id));
  }
  return id;
}

/** A highlight fact of the place's mention `m` (one active extraction run), with the names. */
async function highlightFact(tx: Db, placeObjectId: string, m: TestMention, category: PoiCategory, names: string[], o: { blocked?: boolean } = {}) {
  const run = await insertExtraction(tx, placeObjectId, m, o.blocked ? { status: "blocked" } : {});
  const id = await insertMentionFact(tx, placeObjectId, m, run, { attribute: `highlight.${category}`, value: { present: true, names } });
  const [f] = await tx.select({ chunkId: facts.quoteChunkId, start: facts.quoteStart, end: facts.quoteEnd }).from(facts).where(eq(facts.id, id));
  return f!;
}

/** The POI mention extraction writes for a highlight name it links (`matchPoi`): the fact's span, on the POI. */
async function poiMention(tx: Db, poiId: string, m: TestMention, span: { chunkId: string | null; start: number | null; end: number | null }) {
  await tx.insert(mentions).values({
    documentVersionId: m.versionId,
    chunkId: span.chunkId!,
    geoObjectId: poiId,
    surface: "x",
    charStart: span.start!,
    charEnd: span.end!,
    observedAt: "2026-10-19",
    confidence: 0.8,
    matchKind: "model",
  });
}

describe("loadHighlightCandidates", () => {
  it("loads POIs within 20 km with importance, not one at 21 km", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx, { lon: LON, lat: LAT - 2 * LAT_PER_KM });
      // the anchor is 2 km north of the position: distances count from it
      await tx.update(places).set({ anchorPosition: geomFromGeoJson({ type: "Point", coordinates: [LON, LAT] }) }).where(eq(places.id, place.placeId));
      const qid = `Q${900000000 + Math.floor(Math.random() * 99999999)}`;
      const castle = await poi(tx, "Kastro", "culture", 19.5, { tags: { historic: "castle" }, wikidataId: qid });
      await tx.insert(wikidataSitelinks).values({ wikidataId: qid, sitelinks: 24, fetchedAt: new Date("2026-10-01T00:00:00Z") });
      const sourceId = await insertSource(tx, "pilot_guide", 0.9);
      await insertMention(tx, castle, { sourceId });
      await insertMention(tx, castle, { sourceId });
      const far = await poi(tx, "Far Beach", "beach", 21);
      const plain = await poi(tx, "Taverna", "food", 0.5);

      const { candidates } = await loadHighlightCandidates(tx, place.objectId, cfg, today);
      const own = candidates.filter((c) => [castle, far, plain].includes(c.geoObjectId));
      expect(own.map((c) => c.geoObjectId).sort()).toEqual([castle, plain].sort());

      const expected = importanceOf({ sources: [{ key: `source:${sourceId}`, weight: 0.9 }], sitelinks: 24, category: "culture", kinds: ["historic=castle"] }, cfg);
      const c = own.find((x) => x.geoObjectId === castle)!;
      expect(c).toMatchObject({ category: "culture", name: "Kastro", nameNormalized: "kastro", importance: expected.importance, score: expected.score, lon: LON });
      expect(c.distanceKm).toBeCloseTo(19.5, 1);
      expect(c.lat).toBeCloseTo(LAT + 19.5 * LAT_PER_KM, 6);
      const t = own.find((x) => x.geoObjectId === plain)!;
      expect(t).toMatchObject({ importance: 1, score: 0 });
      expect(t.distanceKm).toBeCloseTo(0.5, 1);
    }));

  it("a name linked to a POI mention is not a text name, an unlinked one is", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx, { lon: LON, lat: LAT });
      const nikos = await poi(tx, "Taverna Nikos", "food", 0.5);
      const kastro = await poi(tx, "Kastro", "culture", 1);

      // two names, one linked: the POI that carries the name takes it
      const m1 = await insertMention(tx, place.objectId, { sourceId: await insertSource(tx) });
      await poiMention(tx, nikos, m1, await highlightFact(tx, place.objectId, m1, "food", ["Taverna Nikos", "Taverna Unbekannt"]));
      // one name, linked by a fuzzy match: the mention at its span links it
      const m2 = await insertMention(tx, place.objectId, { sourceId: await insertSource(tx) });
      await poiMention(tx, kastro, m2, await highlightFact(tx, place.objectId, m2, "culture", ["Kastro Paleo"]));
      // no mention: a text name, counted once although two facts name it
      const m3 = await insertMention(tx, place.objectId, { sourceId: await insertSource(tx) });
      await highlightFact(tx, place.objectId, m3, "culture", ["Moní Agíou Nikoláou"]);
      const m4 = await insertMention(tx, place.objectId, { sourceId: await insertSource(tx) });
      await highlightFact(tx, place.objectId, m4, "culture", ["Moni Agiou Nikolaou"]);
      // a fact of an inactive (blocked) run does not count
      const m5 = await insertMention(tx, place.objectId, { sourceId: await insertSource(tx) });
      await highlightFact(tx, place.objectId, m5, "beach", ["Old Beach"], { blocked: true });

      const { candidates, textNames } = await loadHighlightCandidates(tx, place.objectId, cfg, today);
      expect(textNames).toEqual([
        { category: "culture", nameNormalized: "moni agiou nikolaou" },
        { category: "food", nameNormalized: "taverna unbekannt" },
      ]);
      // the linked mentions count as the POIs' sources
      expect(candidates.find((c) => c.geoObjectId === nikos)!.score).toBeGreaterThan(0);
    }));

  it("a fuzzily linked name of a fact with two names is no text name, the other one is", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx, { lon: LON, lat: LAT });
      const kastro = await poi(tx, "Kastro", "culture", 1);
      const m = await insertMention(tx, place.objectId, { sourceId: await insertSource(tx) });
      await poiMention(tx, kastro, m, await highlightFact(tx, place.objectId, m, "culture", ["Kastro Paleo", "Unknown Taverna"]));

      const { textNames } = await loadHighlightCandidates(tx, place.objectId, cfg, today);
      expect(textNames).toEqual([{ category: "culture", nameNormalized: "unknown taverna" }]);
    }));

  it("merged and ended POIs are left out", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx, { lon: LON, lat: LAT });
      const root = await poi(tx, "Chapel", "culture", 1);
      const merged = await poi(tx, "Chapel Old", "culture", 1.1);
      await tx.update(geoObjects).set({ mergedIntoId: root }).where(eq(geoObjects.id, merged));
      const ended = await poi(tx, "Gone Beach", "beach", 2);
      await tx.update(geoObjects).set({ validFrom: "2000-01-01", validTo: "2000-01-02" }).where(eq(geoObjects.id, ended));
      const uncategorised = await poi(tx, "Something", null, 2);
      // a mention of the merged object counts for the one it was merged into
      const sourceId = await insertSource(tx, "pilot_guide", 0.9);
      await insertMention(tx, merged, { sourceId });

      const { candidates } = await loadHighlightCandidates(tx, place.objectId, cfg, today);
      const ids = candidates.map((c) => c.geoObjectId);
      expect(ids).toContain(root);
      expect(ids).not.toContain(merged);
      expect(ids).not.toContain(ended);
      expect(ids).not.toContain(uncategorised);
      const expected = importanceOf({ sources: [{ key: `source:${sourceId}`, weight: 0.9 }], sitelinks: null, category: "culture", kinds: [] }, cfg);
      expect(candidates.find((c) => c.geoObjectId === root)!.score).toBe(expected.score);
    }));

  it("a POI without a name is no candidate (final review minor)", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx, { lon: LON, lat: LAT });
      const named = await poi(tx, "Kapelle Agios Nikolaos", "culture", 0.3);
      const nameless = await insertNamedObject(tx, { type: "poi", category: "culture", names: [], lon: LON, lat: LAT + 0.2 * LAT_PER_KM });
      const { candidates } = await loadHighlightCandidates(tx, place.objectId, cfg, today);
      const own = candidates.filter((c) => [named, nameless].includes(c.geoObjectId)).map((c) => c.geoObjectId);
      expect(own).toEqual([named]);
    }));

  it("an object without a place has no candidates", () =>
    withRollback(async (tx) => {
      const lone = await insertNamedObject(tx, { type: "bay", names: [{ name: "Lone" }], lon: LON, lat: LAT });
      await poi(tx, "Kastro", "culture", 1);
      expect(await loadHighlightCandidates(tx, lone, cfg, today)).toEqual({ candidates: [], textNames: [] });
    }));

  it("re-exports poiKinds", () => expect(poiKinds({ man_made: "lighthouse" })).toEqual(["man_made=lighthouse"]));
});
