import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestTile, type TestNamedObject } from "@/test/text";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { candidateObjects, withNeighbours } from "@/lib/domain/gazetteer/candidates";
import { tileIdFor } from "@/lib/domain/tiles";
import { resolveHits, type MatchHit } from "../name-match/match";

const config: AppConfig = loadConfig("config");
const A = tileIdFor(21.1, 35.1); // q025:804:500
const B = tileIdFor(21.3, 35.1); // east neighbour
const C = tileIdFor(21.6, 35.1); // two tiles east

async function grid(tx: Db, areaId: string | null = null) {
  for (const t of [A, B, C]) await insertTestTile(tx, t, areaId);
}

const at = (tile: string): Pick<TestNamedObject, "lon" | "lat" | "tiles"> => {
  const col = Number(tile.split(":")[1]);
  return { lon: col * 0.25 - 180 + 0.1, lat: 35.1, tiles: [tile] };
};

describe("candidate space", () => {
  it("rings add the 8 and the 24 tiles around", () => {
    expect(withNeighbours([A], 1)).toHaveLength(9);
    expect(withNeighbours([A], 2)).toHaveLength(25);
    expect(withNeighbours([A, B], 1)).toHaveLength(12);
  });

  it("candidate objects are the tiles' objects plus their ancestors", () =>
    withRollback(async (tx) => {
      const area = await insertNamedObject(tx, { type: "area", names: [{ name: "Testrevier" }], lon: 21.2, lat: 35.2 });
      await grid(tx, area);
      const gulf = await insertNamedObject(tx, { type: "gulf", names: [{ name: "Testgolf" }], lon: 30, lat: 30, parentId: area });
      const bay = await insertNamedObject(tx, { type: "bay", names: [{ name: "Testbucht" }], ...at(A), parentId: gulf });
      const other = await insertNamedObject(tx, { type: "bay", names: [{ name: "Fern" }], ...at(C) });
      const ids = await candidateObjects(tx, [A]);
      expect(ids).toEqual(expect.arrayContaining([area, gulf, bay]));
      expect(ids).not.toContain(other);
    }));
});

describe("resolveHits", () => {
  const hit = (o: Partial<MatchHit>): MatchHit => ({
    start: 0,
    end: 5,
    surface: "Vathy",
    geoObjectId: "a",
    similarity: 1,
    exact: true,
    hint: null,
    objectType: "bay",
    ...o,
  });

  it("one exact object beats fuzzy ones; several exact ones are ambiguous, at most maxCandidates", () => {
    const cfg = { mentions: { ...config.mentions, maxCandidates: 2 }, nameAffixes: config.nameAffixes };
    expect(resolveHits([hit({}), hit({ geoObjectId: "b", exact: false, similarity: 0.8 })], cfg)).toEqual([{ kind: "sure", hit: hit({}) }]);
    const three = [hit({}), hit({ geoObjectId: "b" }), hit({ geoObjectId: "c", exact: false, similarity: 0.7 })];
    expect(resolveHits(three, cfg)).toEqual([
      {
        kind: "ambiguous",
        start: 0,
        end: 5,
        surface: "Vathy",
        hint: null,
        candidates: [
          { geoObjectId: "a", similarity: 1 },
          { geoObjectId: "b", similarity: 1 },
        ],
      },
    ]);
  });

  it("overlapping shorter spans are dropped", () => {
    const cfg = { mentions: config.mentions, nameAffixes: config.nameAffixes };
    const long = hit({ start: 0, end: 11, surface: "Agia Marina", geoObjectId: "am" });
    const short = hit({ start: 5, end: 11, surface: "Marina", geoObjectId: "m" });
    const later = hit({ start: 20, end: 25, surface: "Vathy", geoObjectId: "v" });
    expect(resolveHits([short, later, long], cfg).map((r) => (r.kind === "sure" ? r.hit.geoObjectId : r.kind))).toEqual(["am", "v"]);
  });

  it("a band-only outer span offers the exact name inside it as a candidate too", () => {
    const cfg = { mentions: config.mentions, nameAffixes: config.nameAffixes };
    const outer = hit({ start: 0, end: 12, surface: "Kolona Beach", geoObjectId: "kalona-beach", exact: false, similarity: 0.65 });
    const inner = hit({ start: 0, end: 6, surface: "Kolona", geoObjectId: "kolona" });
    expect(resolveHits([inner, outer], cfg)).toEqual([
      {
        kind: "ambiguous",
        start: 0,
        end: 12,
        surface: "Kolona Beach",
        hint: null,
        candidates: [
          { geoObjectId: "kolona", similarity: 1 },
          { geoObjectId: "kalona-beach", similarity: 0.65 },
        ],
      },
    ]);
    // an outer span with a sure hit of its own keeps only its own objects
    const sureOuter = hit({ start: 0, end: 12, surface: "Kolona Beach", geoObjectId: "kolona-beach" });
    expect(resolveHits([inner, sureOuter], cfg)).toEqual([{ kind: "sure", hit: sureOuter }]);
  });

  it("a lowercase or common one-word hit is never sure without an affix", () => {
    const cfg = { mentions: config.mentions, nameAffixes: config.nameAffixes };
    const ambiguousIds = (h: MatchHit) => {
      const [r] = resolveHits([h], cfg);
      return r!.kind === "ambiguous" ? r!.candidates.map((c) => c.geoObjectId) : r!.kind;
    };
    expect(ambiguousIds(hit({ surface: "άμμος", end: 5 }))).toEqual(["a"]);
    expect(ambiguousIds(hit({ surface: "Ammos" }))).toEqual(["a"]);
    expect(ambiguousIds(hit({ surface: "Strand", end: 6 }))).toEqual(["a"]);
    expect(ambiguousIds(hit({ surface: "vathy" }))).toEqual(["a"]);
    expect(ambiguousIds(hit({ surface: "Vathy" }))).toBe("sure");
    // two words with an affix are backed by it
    expect(ambiguousIds(hit({ surface: "Ammos Bay", end: 9, hint: "bay" }))).toBe("sure");
  });
});

