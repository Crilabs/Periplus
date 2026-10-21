import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { consolidationSchema } from "@/lib/config/schemas";
import { highlightsConfig, selectHighlights, type HighlightCandidate } from "../select";

/* Calibration of the culture level against three synthetic place types (spec 16). Reads the real config. */

const raw = JSON.parse(readFileSync("config/consolidation/v2.json", "utf8"));
const consolidation = consolidationSchema.parse(raw);
const cfg = highlightsConfig(consolidation);
const duplicateM = 500;

function cand(id: string, importance: 1 | 2 | 3 | 4 | 5, distanceKm: number): HighlightCandidate {
  return { geoObjectId: id, category: "culture", name: id, nameNormalized: id, importance, score: 0, distanceKm, lon: 25, lat: 36 };
}
const many = (prefix: string, n: number, importance: 1 | 2 | 3 | 4 | 5, distanceKm: number) =>
  Array.from({ length: n }, (_, i) => cand(`${prefix}${i}`, importance, distanceKm));

describe("highlight level calibration (culture)", () => {
  it("Agistri-like: one ruin of importance 2 -> none", () => {
    const r = selectHighlights([cand("ruin", 2, 0.6)], [], cfg, duplicateM);
    expect(r.culture?.level).toBe("none");
  });

  it("Poros-like: a monastery, a few churches and ruins, some trivia -> some", () => {
    const list = [
      cand("monastery", 4, 6),
      ...many("church", 6, 3, 2),
      ...many("ruin", 3, 2, 0.8),
      ...many("chapel", 30, 1, 0.7),
    ];
    const r = selectHighlights(list, [], cfg, duplicateM);
    expect(r.culture?.level).toBe("some");
  });

  it("Athens-like: Acropolis, many museums and sites, thousands of trivia -> many", () => {
    const list = [
      cand("acropolis", 5, 3),
      ...many("museum", 20, 4, 4),
      ...many("site", 40, 3, 3),
      ...many("trivia", 3000, 1, 0.9),
    ];
    const r = selectHighlights(list, [], cfg, duplicateM);
    expect(r.culture?.ids).toHaveLength(5);
    expect(r.culture?.level).toBe("many");
  });
});
