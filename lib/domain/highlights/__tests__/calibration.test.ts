import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { consolidationSchema } from "@/lib/config/schemas";
import type { HighlightCategory } from "@/lib/db/schema/geo";
import { importanceOf, type ImportanceInput } from "@/lib/domain/consolidation/derived/importance";
import { highlightsConfig, selectHighlights, type HighlightCandidate } from "../select";

/*
 * Calibration of importance and level against the spec's targets (spec 16 „Wichtigkeit“, „Auswahl je Ort“). Every
 * candidate goes through `importanceOf` with realistic inputs (sitelinks, OSM tags / Wikidata classes, text sources of
 * the weights in config/source-types.json); reads the real config v2.
 */

const consolidation = consolidationSchema.parse(JSON.parse(readFileSync("config/consolidation/v2.json", "utf8")));
const cfg = highlightsConfig(consolidation);
const duplicateM = 500;

/** `n` text sources of weight `weight` (each its own source). */
const sources = (n: number, weight: number, prefix = "s") => Array.from({ length: n }, (_, i) => ({ key: `source:${prefix}${i}`, weight }));

type Poi = Omit<ImportanceInput, "sources"> & { sources?: ImportanceInput["sources"] };
const importance = (p: Poi) => importanceOf({ sources: [], ...p }, consolidation).importance;

// realistic inputs of the spec's named POIs (sitelinks rounded from Wikidata, kinds as OSM / Wikidata carry them)
const ACROPOLIS: Poi = { category: "culture", sitelinks: 150, kinds: ["historic=archaeological_site", "wikidata:Q839954"], sources: sources(5, 0.6) };
const APHAIA: Poi = { category: "culture", sitelinks: 25, kinds: ["historic=archaeological_site", "wikidata:Q839954"] };
const ZOODOCHOS_PIGI: Poi = { category: "culture", sitelinks: 5, kinds: ["amenity=place_of_worship", "wikidata:Q44613"] };
const CHAPEL: Poi = { category: "culture", sitelinks: null, kinds: ["amenity=place_of_worship"] };
const SHRINE: Poi = { category: "culture", sitelinks: null, kinds: ["historic=wayside_shrine"] };
const TAVERNA: Poi = { category: "food", sitelinks: null, kinds: ["amenity=restaurant"] };
const RUIN: Poi = { category: "culture", sitelinks: null, kinds: ["historic=ruins"] };

describe("importance calibration (spec 16 „Wichtigkeit“)", () => {
  it("the Acropolis is 5", () => {
    expect(importance(ACROPOLIS)).toBe(5);
    // even with fewer text sources than the five assumed
    expect(importance({ ...ACROPOLIS, sources: sources(2, 0.6) })).toBe(5);
  });

  it("the Temple of Aphaia is 3–4, with none to three text sources", () => {
    for (const n of [0, 1, 2, 3]) {
      const i = importance({ ...APHAIA, sources: sources(n, 0.7) });
      expect(i, `${n} sources`).toBeGreaterThanOrEqual(3);
      expect(i, `${n} sources`).toBeLessThanOrEqual(4);
    }
  });

  it("the Zoodochos Pigi monastery is 3–4, with none to three text sources", () => {
    for (const n of [0, 1, 2, 3]) {
      const i = importance({ ...ZOODOCHOS_PIGI, sources: sources(n, 0.7) });
      expect(i, `${n} sources`).toBeGreaterThanOrEqual(3);
      expect(i, `${n} sources`).toBeLessThanOrEqual(4);
    }
  });

  it("a chapel, a wayside shrine or a single taverna without a text mention is 1–2", () => {
    for (const p of [CHAPEL, SHRINE, TAVERNA]) expect(importance(p)).toBeLessThanOrEqual(2);
    // the plain ones are 1, so thousands of them weigh little in the level
    expect(importance(CHAPEL)).toBe(1);
    expect(importance(TAVERNA)).toBe(1);
  });

  it("a ruin without sitelinks or text is 2 (the spec's island with one ruin)", () => {
    expect(importance(RUIN)).toBe(2);
  });
});

/** A candidate of `category` built through `importanceOf`. */
function cand(id: string, p: Poi, distanceKm: number): HighlightCandidate {
  const imp = importanceOf({ sources: [], ...p }, consolidation);
  return { geoObjectId: id, category: p.category as HighlightCategory, name: id, nameNormalized: id, importance: imp.importance, score: imp.score, distanceKm, lon: 25, lat: 36 };
}
const many = (prefix: string, n: number, p: Poi, distanceKm: number) => Array.from({ length: n }, (_, i) => cand(`${prefix}${i}`, p, distanceKm));

describe("highlight level calibration (culture, through importanceOf)", () => {
  it("Agistri-like: one ruin and a few chapels -> the ruin, none", () => {
    const r = selectHighlights([cand("ruin", RUIN, 0.6), ...many("chapel", 10, CHAPEL, 0.7)], [], cfg, duplicateM);
    expect(r.culture?.ids[0]).toBe("ruin");
    expect(r.culture?.level).toBe("none");
  });

  it("Poros-like: monastery, temple, museum, a few ruins and churches named in texts, chapels -> some", () => {
    const list = [
      cand("monastery", { ...ZOODOCHOS_PIGI, sources: sources(1, 0.9) }, 4),
      cand("temple", { category: "culture", sitelinks: 8, kinds: ["historic=archaeological_site"] }, 4.5),
      cand("museum", { category: "culture", sitelinks: 3, kinds: ["tourism=museum"] }, 0.3),
      cand("naval-base", { category: "culture", sitelinks: 2, kinds: ["historic=ruins"] }, 0.9),
      cand("clock-tower", { category: "culture", sitelinks: 3, kinds: [], sources: sources(1, 0.6) }, 0.4),
      ...many("church", 3, { category: "culture", sitelinks: null, kinds: ["amenity=place_of_worship"], sources: sources(1, 0.6) }, 0.6),
      ...many("ruin", 2, RUIN, 0.8),
      ...many("chapel", 30, CHAPEL, 0.7),
    ];
    const r = selectHighlights(list, [], cfg, duplicateM);
    expect(r.culture?.ids.slice(0, 3).sort()).toEqual(["monastery", "museum", "temple"]);
    expect(r.culture?.level).toBe("some");
  });

  it("Athens-like: Acropolis, museums and sites, thousands of trivia -> many; the trivia alone are not many", () => {
    const list = [
      cand("acropolis", ACROPOLIS, 3),
      cand("national-museum", { category: "culture", sitelinks: 60, kinds: ["tourism=museum"], sources: sources(3, 0.6) }, 4),
      ...many("museum", 20, { category: "culture", sitelinks: 20, kinds: ["tourism=museum"], sources: sources(1, 0.6) }, 4),
      ...many("site", 40, { category: "culture", sitelinks: null, kinds: ["historic=archaeological_site"] }, 3),
      ...many("trivia", 3000, CHAPEL, 0.9),
    ];
    const r = selectHighlights(list, [], cfg, duplicateM);
    expect(r.culture?.ids).toHaveLength(5);
    expect(r.culture?.ids[0]).toBe("acropolis");
    expect(r.culture?.level).toBe("many");

    const trivia = selectHighlights(many("trivia", 1000, CHAPEL, 0.9), [], cfg, duplicateM);
    expect(trivia.culture?.level).not.toBe("many");
  });
});
