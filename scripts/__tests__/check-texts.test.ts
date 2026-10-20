import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestTile, insertTestVersion } from "@/test/text";
import { getConfig, type AppConfig } from "@/lib/config";
import { ambiguousMatches, mentions, unmatchedNames } from "@/lib/db/schema";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { newId } from "@/lib/domain/ids";
import { measureTileBorders } from "@/lib/domain/mentions/tile-borders";
import { tileIdFor } from "@/lib/domain/tiles";
import { assessTexts, matchMentionCounts, textCheckFailures, textStats, type TextStats } from "../check-texts";

// Own tiles of this file (OPS-4): no other test file inserts them, so no uncommitted primary key is shared with a
// test running in parallel. TILE_C lies two columns east of TILE_A (the second ring).
const TILE_A = tileIdFor(-100.1, 10.1);
const TILE_C = tileIdFor(-99.6, 10.1);

const stats = (over: Partial<TextStats> = {}): TextStats => ({
  belegtreue: { facts: 120, verified: 120 },
  blockedRuns: 0,
  mentions: 1000,
  deterministicMentions: 800,
  anthropicEur: 2.5,
  routes: { routes: 3, complete: 2, openStops: 1 },
  tileBorders: { unmatchedNames: 10, matchedWithRing2: 1 },
  ...over,
});

/** The repo configuration with the extraction decision set explicitly (never the live status, which M7 changes). */
const withDecision = (status: "provisional" | "decided"): AppConfig => {
  const base = getConfig();
  const task = base.models.tasks["extract-facts"]!;
  return { ...base, models: { ...base.models, tasks: { ...base.models.tasks, "extract-facts": { ...task, decision: { status, note: "Sonnet nach Vergleich." } } } } };
};
const decided = () => withDecision("decided");

/** A unique made-up place name (letters only). */
const uniqueName = () => `Zor${newId().replace(/-/g, "").slice(-8).replace(/\d/g, (d) => "abcdefghij"[Number(d)]!)}`;

describe("check-texts", () => {
  it("reports a provisional model and a 0.65 deterministic share as failing", () => {
    const result = assessTexts(stats({ deterministicMentions: 650 }), withDecision("provisional"));
    expect(result).toMatchObject({ modelDecision: "provisional", deterministicShare: 0.65, costPerMentionEur: 0.0025, belegtreue: { ratio: 1 } });
    expect(textCheckFailures(result)).toEqual([
      "extraction model decision is provisional (config/models.json tasks.extract-facts.decision.status)",
      "share of mentions without a model call 65.0 % not above 70 %",
    ]);
  });

  it("ratio 1 with decided model and 0.8 share passes", () => {
    const result = assessTexts(stats(), decided());
    expect(result).toEqual({
      belegtreue: { facts: 120, verified: 120, ratio: 1 },
      blockedRuns: 0,
      modelDecision: "decided",
      costPerMentionEur: 0.0025,
      deterministicShare: 0.8,
      minDeterministicShare: 0.7,
      mentions: 1000,
      routes: { routes: 3, complete: 2, openStops: 1 },
      tileBorders: { unmatchedNames: 10, matchedWithRing2: 1 },
    });
    expect(textCheckFailures(result)).toEqual([]);
    // exactly 70 % is not above 70 %; one unverified fact or a blocked run fails as well
    expect(textCheckFailures(assessTexts(stats({ deterministicMentions: 700, belegtreue: { facts: 120, verified: 119 }, blockedRuns: 1 }), decided()))).toEqual([
      "Belegtreue 99.17 % (119 of 120) below 100 %",
      "1 blocked extraction run(s): check them on their run page",
      "share of mentions without a model call 70.0 % not above 70 %",
    ]);
    // without mentions there is no cost per mention, and the share fails
    expect(assessTexts(stats({ mentions: 0, deterministicMentions: 0 }), decided())).toMatchObject({ costPerMentionEur: null, deterministicShare: 0 });
  });

  it("the share threshold comes from the configuration", () => {
    const cfg = decided();
    const stricter: AppConfig = { ...cfg, extraction: { ...cfg.extraction, acceptance: { minDeterministicShare: 0.85 } } };
    expect(textCheckFailures(assessTexts(stats(), stricter))).toEqual(["share of mentions without a model call 80.0 % not above 85 %"]);
  });

  it("the share counts the match's mentions only: a disambiguated one counts, a POI mention of the extraction does not", () =>
    withRollback(async (tx) => {
      const tile = await insertTestTile(tx, TILE_A);
      const a = await insertNamedObject(tx, { type: "bay", names: [{ name: uniqueName() }], lon: -100.1, lat: 10.1, tiles: [tile] });
      const v = await insertTestVersion(tx, ["Kolona Vathy Taverna"]);
      const mention = (start: number, matchKind: "deterministic" | "model") => ({
        documentVersionId: v.versionId,
        chunkId: v.chunkIds[0]!,
        geoObjectId: a,
        surface: "x",
        charStart: start,
        charEnd: start + 5,
        observedAt: "2026-10-19",
        confidence: 1,
        matchKind,
      });
      await tx.insert(mentions).values([mention(0, "deterministic"), mention(7, "model"), mention(13, "model")]);
      // the span at 7 was ambiguous and the disambiguation chose; the one at 13 is a POI mention of the extraction
      await tx.insert(ambiguousMatches).values({ documentVersionId: v.versionId, chunkId: v.chunkIds[0]!, surface: "Vathy", charStart: 7, charEnd: 12, candidates: [], status: "resolved" });
      expect(await matchMentionCounts(tx, { versionIds: [v.versionId] })).toEqual({ mentions: 2, deterministic: 1 });
    }));

  it("the tile border measurement finds an unmatched name in the second ring and writes nothing", () =>
    withRollback(async (tx) => {
      const cfg = getConfig();
      const tile = await insertTestTile(tx, TILE_A);
      await insertTestTile(tx, TILE_C);
      await insertNamedObject(tx, { type: "island", names: [{ name: "Kalonisi" }], lon: -100.08, lat: 10.12, tiles: [tile] });
      const far = uniqueName();
      const nowhere = uniqueName();
      await insertNamedObject(tx, { type: "bay", names: [{ name: far }], lon: -99.6, lat: 10.1, tiles: [TILE_C] });
      const v = await insertTestVersion(tx, [`Rund um Kalonisi, dann weiter nach ${far} und ${nowhere}.`]);
      for (const name of [far, nowhere]) {
        await tx.insert(unmatchedNames).values({ nameNormalized: normalizeName(name), displayName: name, documentVersionId: v.versionId, chunkId: v.chunkIds[0]!, sourceId: v.sourceId, tileId: tile });
      }
      expect(await measureTileBorders(tx, cfg, { versionIds: [v.versionId] })).toEqual({ unmatchedNames: 2, matchedWithRing2: 1 });
      // older entries are outside the window
      expect(await measureTileBorders(tx, cfg, { versionIds: [v.versionId], since: new Date(Date.now() + 86_400_000) })).toEqual({ unmatchedNames: 0, matchedWithRing2: 0 });
      // the database-wide numbers include the scene (never asserted as exact counts: other tests write too)
      const all = await textStats(tx, cfg);
      expect(all.tileBorders.unmatchedNames).toBeGreaterThanOrEqual(2);
      expect(all.belegtreue.verified).toBeLessThanOrEqual(all.belegtreue.facts);
    }));
});
