import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestRun, insertTestTile, insertTestVersion, type TestNamedObject } from "@/test/text";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { ambiguousMatches, mentions, unmatchedNames } from "@/lib/db/schema";
import { tileIdFor } from "@/lib/domain/tiles";
import { matchVersion } from "@/lib/pipeline/text/mentions";
import { candidateObjects, candidateTiles, withNeighbours } from "../scope";
import { resolveHits, type MatchHit } from "../match";

/*
 * Synthetic objects around 21.0° E / 35.2° N (tiles q025:804:500 ff., outside the pilot box), always in withRollback.
 * Every text names the island "Kalonisi" (a prepass type), so the document touches tile A.
 */

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

async function island(tx: Db, parentId: string | null = null) {
  return insertNamedObject(tx, { type: "island", names: [{ name: "Kalonisi" }], ...at(A), parentId });
}

async function run(tx: Db, texts: string[], cfg: AppConfig = config) {
  const runId = await insertTestRun(tx);
  const v = await insertTestVersion(tx, texts);
  const counts = await matchVersion(tx, v.versionId, { runId, cfg });
  const ms = await tx.select().from(mentions).where(eq(mentions.documentVersionId, v.versionId)).orderBy(mentions.charStart);
  const amb = await tx.select().from(ambiguousMatches).where(eq(ambiguousMatches.documentVersionId, v.versionId)).orderBy(ambiguousMatches.charStart);
  const un = await tx.select().from(unmatchedNames).where(eq(unmatchedNames.documentVersionId, v.versionId)).orderBy(unmatchedNames.nameNormalized);
  return { ...v, runId, counts, ms, amb, un };
}

describe("name match", () => {
  it("an exact unique name is a deterministic mention with confidence 1", () =>
    withRollback(async (tx) => {
      await grid(tx);
      const kalonisi = await island(tx);
      const kolona = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], ...at(A) });
      const r = await run(tx, ["Wir ankerten vor Kolona bei Kalonisi."]);
      expect(r.ms.map((m) => [m.surface, m.geoObjectId])).toEqual([
        ["Kolona", kolona],
        ["Kalonisi", kalonisi],
      ]);
      const text = "Wir ankerten vor Kolona bei Kalonisi.";
      for (const m of r.ms) expect(text.slice(m.charStart, m.charEnd)).toBe(m.surface);
      expect(r.ms[0]).toMatchObject({ matchKind: "deterministic", confidence: 1, matchScore: 1, observedAt: "2026-10-19", runId: r.runId });
      expect(r.amb).toEqual([]);
      expect(r.counts).toEqual({ mentions: 2, ambiguous: 0, unmatched: 0, chunks: 1 });
    }));

  it("longest match wins and affix-only names never match", () =>
    withRollback(async (tx) => {
      await grid(tx);
      await island(tx);
      const agiaMarina = await insertNamedObject(tx, { type: "bay", names: [{ name: "Agia Marina" }], ...at(A) });
      await insertNamedObject(tx, { type: "harbour", names: [{ name: "Marina" }], ...at(A) });
      const inBay = await run(tx, ["Abends lagen wir in Agia Marina vor Kalonisi."]);
      expect(inBay.ms.filter((m) => m.surface !== "Kalonisi").map((m) => [m.surface, m.geoObjectId])).toEqual([["Agia Marina", agiaMarina]]);
      expect(inBay.amb).toEqual([]);
      const toMarina = await run(tx, ["Später zur Marina von Kalonisi."]);
      expect(toMarina.ms.map((m) => m.surface)).toEqual(["Kalonisi"]);
      expect(toMarina.amb).toEqual([]);
    }));

  it("two objects with the same name in neighbour tiles are ambiguous with both candidates", () =>
    withRollback(async (tx) => {
      await grid(tx);
      await island(tx);
      const vathyA = await insertNamedObject(tx, { type: "bay", names: [{ name: "Vathy" }], ...at(A) });
      const vathyB = await insertNamedObject(tx, { type: "bay", names: [{ name: "Vathy" }], ...at(B) });
      const r = await run(tx, ["Von Kalonisi weiter nach Vathy."]);
      expect(r.ms.map((m) => m.surface)).toEqual(["Kalonisi"]);
      expect(r.amb).toHaveLength(1);
      expect(r.amb[0]).toMatchObject({ surface: "Vathy", status: "pending", typeHint: null, runId: r.runId });
      expect((r.amb[0]!.candidates as Array<{ geoObjectId: string }>).map((c) => c.geoObjectId).sort()).toEqual([vathyA, vathyB].sort());
    }));

  it("a 'Bay' hint picks the one bay among same-named objects", () =>
    withRollback(async (tx) => {
      await grid(tx);
      await island(tx);
      const bay = await insertNamedObject(tx, { type: "bay", names: [{ name: "Vathy" }], ...at(A) });
      await insertNamedObject(tx, { type: "harbour", names: [{ name: "Vathy" }], ...at(A) });
      const hinted = await run(tx, ["Auf Kalonisi ankerten wir in der Vathy Bay."]);
      expect(hinted.ms.filter((m) => m.geoObjectId === bay).map((m) => [m.surface, m.typeHint])).toEqual([["Vathy Bay", "bay"]]);
      expect(hinted.amb).toEqual([]);
      // without a hint the two stay ambiguous
      const plain = await run(tx, ["Auf Kalonisi lagen wir in Vathy."]);
      expect(plain.amb).toHaveLength(1);
    }));

  it("'porto heli' against 'porto cheli' lands in the uncertain band", () =>
    withRollback(async (tx) => {
      await grid(tx);
      await island(tx);
      const portoCheli = await insertNamedObject(tx, { type: "harbour", names: [{ name: "Porto Cheli" }], ...at(A) });
      const r = await run(tx, ["Von Kalonisi nach Porto Heli."]);
      expect(r.ms.map((m) => m.surface)).toEqual(["Kalonisi"]);
      expect(r.amb).toHaveLength(1);
      expect(r.amb[0]).toMatchObject({ surface: "Porto Heli", typeHint: "harbour" });
      const [c] = r.amb[0]!.candidates as Array<{ geoObjectId: string; similarity: number }>;
      expect(c!.geoObjectId).toBe(portoCheli);
      expect(c!.similarity).toBeGreaterThanOrEqual(config.mentions.uncertainSimilarity);
      expect(c!.similarity).toBeLessThan(config.mentions.sureSimilarity);
    }));

  it("greek text matches the latin transliteration exactly", () =>
    withRollback(async (tx) => {
      await grid(tx);
      await island(tx);
      const portoCheli = await insertNamedObject(tx, { type: "harbour", names: [{ name: "Porto Cheli" }], ...at(A) });
      const r = await run(tx, ["Kalonisi. Μετά πήγαμε στο Πόρτο Χέλι."]);
      expect(r.ms.filter((m) => m.geoObjectId === portoCheli).map((m) => [m.surface, m.confidence])).toEqual([["Πόρτο Χέλι", 1]]);
      expect(r.amb).toEqual([]);
    }));

  it("an object two tiles away matches only with neighbourRing 2", () =>
    withRollback(async (tx) => {
      await grid(tx);
      await island(tx);
      const far = await insertNamedObject(tx, { type: "bay", names: [{ name: "Limnionas" }], ...at(C) });
      const text = ["Von Kalonisi segelten wir nach Limnionas."];
      expect((await run(tx, text)).ms.some((m) => m.geoObjectId === far)).toBe(false);
      const ring2: AppConfig = { ...config, mentions: { ...config.mentions, neighbourRing: 2 } };
      expect((await run(tx, text, ring2)).ms.filter((m) => m.geoObjectId === far).map((m) => m.surface)).toEqual(["Limnionas"]);
    }));

  it("islands and areas are mentioned too", () =>
    withRollback(async (tx) => {
      const area = await insertNamedObject(tx, { type: "area", names: [{ name: "Argolida Testrevier" }], lon: 21.2, lat: 35.2, configKey: `test-${A}-${Date.now()}` });
      await grid(tx, area);
      const kalonisi = await island(tx, area);
      const r = await run(tx, ["Das Argolida Testrevier mit Kalonisi ist ruhig."]);
      expect(r.ms.map((m) => [m.surface, m.geoObjectId])).toEqual([
        ["Argolida Testrevier", area],
        ["Kalonisi", kalonisi],
      ]);
    }));

  it("a place hint without any hit is kept as an unmatched name in the tile of the nearest mention", () =>
    withRollback(async (tx) => {
      await grid(tx);
      await island(tx);
      await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], ...at(B) });
      const r = await run(tx, ["Erst Kolona, dann Kalonisi. In Fengari Bay lagen wir allein."]);
      expect(r.un.map((u) => [u.displayName, u.nameNormalized, u.hint, u.tileId, u.sourceId])).toEqual([["Fengari", "fengari", "bay", A, r.sourceId]]);
    }));
});

describe("candidate space", () => {
  it("rings add the 8 and the 24 tiles around", () => {
    expect(withNeighbours([A], 1)).toHaveLength(9);
    expect(withNeighbours([A], 2)).toHaveLength(25);
    expect(withNeighbours([A, B], 1)).toHaveLength(12);
  });

  it("the prepass, earlier versions and the source's searches give the tiles; else the configured areas", () =>
    withRollback(async (tx) => {
      await grid(tx);
      await island(tx);
      const v = await insertTestVersion(tx, ["Nichts Bekanntes hier."]);
      const ctx = { nameAffixes: config.nameAffixes, areaKeys: [] as string[] };
      expect(await candidateTiles(tx, v.versionId, config.mentions, ctx)).toEqual({ tiles: [], basis: "fallback" });
      const named = await insertTestVersion(tx, ["Rund um Kalonisi."]);
      expect(await candidateTiles(tx, named.versionId, config.mentions, ctx)).toEqual({ tiles: withNeighbours([A], 1), basis: "prepass" });
      // the next version of the named document knows its tiles from the mentions of the first
      await matchVersion(tx, named.versionId, { runId: null, cfg: config });
      const next = await insertTestVersion(tx, ["Wieder hier."], { documentId: named.documentId, sourceId: named.sourceId });
      expect(await candidateTiles(tx, next.versionId, config.mentions, ctx)).toEqual({ tiles: withNeighbours([A], 1), basis: "history" });
    }));

  it("candidate objects are the tiles' objects plus their ancestors and label areas", () =>
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
});
