import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestRun, insertTestSource, insertTestTile, insertTestVersion, type TestNamedObject } from "@/test/text";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { ambiguousMatches, geoObjects, mentions, serpQueries, serpResults, sources, unmatchedNames } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
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
  it("ordinary words in greek and german texts never become sure mentions", () =>
    withRollback(async (tx) => {
      await grid(tx);
      await island(tx);
      const ammos = await insertNamedObject(tx, { type: "bay", names: [{ name: "Ammos" }], ...at(A) });
      const strand = await insertNamedObject(tx, { type: "bay", names: [{ name: "Strand" }], ...at(A) });
      const el = await run(tx, ["Στο Kalonisi ο βυθός είναι άμμος."]);
      expect(el.ms.map((m) => m.surface)).toEqual(["Kalonisi"]);
      expect(el.amb.map((a) => [a.surface, (a.candidates as Array<{ geoObjectId: string }>).map((c) => c.geoObjectId)])).toEqual([["άμμος", [ammos]]]);
      const de = await run(tx, ["Vor Kalonisi lagen wir am Strand."]);
      expect(de.ms.map((m) => m.surface)).toEqual(["Kalonisi"]);
      expect(de.amb.map((a) => [a.surface, (a.candidates as Array<{ geoObjectId: string }>).map((c) => c.geoObjectId)])).toEqual([["Strand", [strand]]]);
    }));

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

  it("the prepass, earlier versions and the source's searches give the tiles; else the active subdivisions", () =>
    withRollback(async (tx) => {
      await grid(tx);
      await island(tx);
      const v = await insertTestVersion(tx, ["Nichts Bekanntes hier."]);
      const ctx = { nameAffixes: config.nameAffixes, subdivisionKeys: [] as string[] };
      expect(await candidateTiles(tx, v.versionId, config.mentions, ctx)).toEqual({ tiles: [], basis: "fallback" });
      const named = await insertTestVersion(tx, ["Rund um Kalonisi."]);
      expect(await candidateTiles(tx, named.versionId, config.mentions, ctx)).toEqual({ tiles: withNeighbours([A], 1), basis: "prepass" });
      // the next version of the named document knows its tiles from the mentions of the first
      await matchVersion(tx, named.versionId, { runId: null, cfg: config });
      const next = await insertTestVersion(tx, ["Wieder hier."], {
        documentId: named.documentId,
        sourceId: named.sourceId,
        fetchedAt: new Date("2026-10-20T10:00:00Z"),
      });
      expect(await candidateTiles(tx, next.versionId, config.mentions, ctx)).toEqual({ tiles: withNeighbours([A], 1), basis: "history" });
    }));

  it("history comes only from earlier versions of the document", () =>
    withRollback(async (tx) => {
      await grid(tx);
      await island(tx);
      const ctx = { nameAffixes: config.nameAffixes, subdivisionKeys: [] as string[] };
      const early = await insertTestVersion(tx, ["Nichts Bekanntes hier."], { fetchedAt: new Date("2026-10-01T10:00:00Z") });
      const later = await insertTestVersion(tx, ["Rund um Kalonisi."], {
        documentId: early.documentId,
        sourceId: early.sourceId,
        fetchedAt: new Date("2026-10-19T10:00:00Z"),
      });
      await matchVersion(tx, later.versionId, { runId: null, cfg: config });
      expect(await candidateTiles(tx, early.versionId, config.mentions, ctx)).toEqual({ tiles: [], basis: "fallback" });
    }));

  it("the document's own tiles win; history and the source's area count only without them (spec 06)", () =>
    withRollback(async (tx) => {
      await grid(tx);
      const area = await insertNamedObject(tx, { type: "area", names: [{ name: "Testrevier" }], lon: 21.2, lat: 35.2, configKey: `test-${newId()}`, tiles: [A, B, C] });
      await island(tx);
      const farBay = await insertNamedObject(tx, { type: "bay", names: [{ name: "Fernbucht" }], ...at(C) });
      const ctx = { nameAffixes: config.nameAffixes, subdivisionKeys: [] as string[] };
      // the source was found by a search for the whole area
      const sourceId = await insertTestSource(tx);
      const [src] = await tx.select({ domain: sources.domain }).from(sources).where(eq(sources.id, sourceId));
      const [areaRow] = await tx.select({ key: geoObjects.configKey }).from(geoObjects).where(eq(geoObjects.id, area));
      const [q] = await tx
        .insert(serpQueries)
        .values({ keyword: "testrevier ankern", languageCode: "de", locationCode: 1, depth: 20, level: "area", scopeId: areaRow!.key!, rawKey: "serp/x.json", fetchedAt: new Date() })
        .returning({ id: serpQueries.id });
      await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url: `https://${src!.domain}/a`, urlNormalized: `https://${src!.domain}/a`, domain: src!.domain, title: "t", snippet: "s" });
      // a document naming Kalonisi touches tile A only (its ring), not the whole area
      const named = await insertTestVersion(tx, ["Rund um Kalonisi."], { sourceId, fetchedAt: new Date("2026-10-01T10:00:00Z") });
      expect(await candidateTiles(tx, named.versionId, config.mentions, ctx)).toEqual({ tiles: withNeighbours([A], 1), basis: "prepass" });
      // an earlier mention of the far bay is history; a later version naming Kalonisi still keeps to its own tiles
      await tx.insert(mentions).values({
        documentVersionId: named.versionId,
        chunkId: named.chunkIds[0]!,
        geoObjectId: farBay,
        surface: "Rund",
        charStart: 0,
        charEnd: 4,
        observedAt: "2026-10-01",
        confidence: 1,
        matchKind: "deterministic",
        matchScore: 1,
      });
      const next = await insertTestVersion(tx, ["Wieder um Kalonisi."], { documentId: named.documentId, sourceId });
      expect(await candidateTiles(tx, next.versionId, config.mentions, ctx)).toEqual({ tiles: withNeighbours([A], 1), basis: "prepass" });
      const plain = await insertTestVersion(tx, ["Wieder hier."], { documentId: named.documentId, sourceId, fetchedAt: new Date("2026-10-25T10:00:00Z") });
      expect(await candidateTiles(tx, plain.versionId, config.mentions, ctx)).toEqual({ tiles: withNeighbours([C], 1), basis: "history" });
      // a document of the source without any reference falls back to the source's area
      const other = await insertTestVersion(tx, ["Nichts Bekanntes hier."], { sourceId });
      expect(await candidateTiles(tx, other.versionId, config.mentions, ctx)).toEqual({ tiles: withNeighbours([A, B, C], 1), basis: "source" });
    }));

  it("a test tile that exists with another label area fails instead of skewing the test", () =>
    withRollback(async (tx) => {
      const area = await insertNamedObject(tx, { type: "area", names: [{ name: "Testrevier" }], lon: 21.2, lat: 35.2 });
      await insertTestTile(tx, A, area);
      expect(await insertTestTile(tx, A, area)).toBe(A);
      await expect(insertTestTile(tx, A, null)).rejects.toThrow(/exists with area/);
    }));

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
