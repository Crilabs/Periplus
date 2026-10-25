
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestSource, insertTestSubdivision, insertTestTile, insertTestVersion } from "@/test/text";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { ambiguousMatches, mentions, serpQueries, serpResults, sources, tiles } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { matchVersion } from "@/lib/pipeline/text/mentions";
import { freezeTextRunParams } from "@/lib/pipeline/text/versions";

/*
 * Text runs end to end inside withRollback: the run starters, then every job the run enqueues is executed in order by
 * calling the stage functions directly (no pg-boss worker), message batches through MockModel and `pollBatch` right
 * after each batch stage job. Geo data is the synthetic fixture gazetteer around 21.0° E / 35.2° N.
 */

const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };
const TILE_A = "q025:804:500";

/** The tile with the island Kalonisi: a text naming the island has the tile in its candidate space (prepass). */
async function islandTile(tx: Db): Promise<{ tile: string; island: string }> {
  const tile = await insertTestTile(tx, TILE_A);
  const island = await insertNamedObject(tx, { type: "island", names: [{ name: "Kalonisi" }], lon: 21.12, lat: 35.12, tiles: [tile] });
  return { tile, island };
}

describe("text run", () => {
  it("pending with sourceIds selects only the pending versions of those sources (UI-10)", () =>
    withRollback(async (tx) => {
      const mine = await insertTestVersion(tx, ["Rund um Kalonisi."]);
      const other = await insertTestVersion(tx, ["Rund um Kalonisi."]);
      const { documentVersionIds } = await freezeTextRunParams(tx, { pending: true, sourceIds: [mine.sourceId] }, config);
      expect(documentVersionIds).toEqual([mine.versionId]);
      expect((await freezeTextRunParams(tx, { pending: true }, config)).documentVersionIds).toContain(other.versionId);
    }));

  it("pending selects only versions without a mention pass", () =>
    withRollback(async (tx) => {
      await islandTile(tx);
      const matched = await insertTestVersion(tx, ["Rund um Kalonisi."]);
      const fresh = await insertTestVersion(tx, ["Rund um Kalonisi."]);
      await matchVersion(tx, matched.versionId, { runId: null, cfg: config });
      const { documentVersionIds } = await freezeTextRunParams(tx, { pending: true }, config);
      expect(documentVersionIds).toContain(fresh.versionId);
      expect(documentVersionIds).not.toContain(matched.versionId);
      // another match configuration has not passed the matched version
      const other: AppConfig = { ...config, mentions: { ...config.mentions, maxCandidates: config.mentions.maxCandidates + 1 } };
      expect((await freezeTextRunParams(tx, { pending: true }, other)).documentVersionIds).toContain(matched.versionId);
      // an older version of a document is never pending, only its current one
      const newer = await insertTestVersion(tx, ["Rund um Kalonisi."], { documentId: fresh.documentId, fetchedAt: new Date("2026-10-20T10:00:00Z") });
      const again = await freezeTextRunParams(tx, { pending: true }, config);
      expect(again.documentVersionIds).toContain(newer.versionId);
      expect(again.documentVersionIds).not.toContain(fresh.versionId);
    }));

  it("a tile run takes the versions mentioning its objects plus the pending versions of its sources; a reprocess run no pending ones", () =>
    withRollback(async (tx) => {
      const { tile } = await islandTile(tx);
      const mentioned = await insertTestVersion(tx, ["Rund um Kalonisi."]);
      await matchVersion(tx, mentioned.versionId, { runId: null, cfg: config });
      // a source a SERP search of the tile found, with a version not matched yet; another source without such a search
      const found = await insertTestSource(tx);
      const elsewhere = await insertTestSource(tx);
      const pendingHere = await insertTestVersion(tx, ["Noch nicht abgeglichen."], { sourceId: found });
      const pendingElsewhere = await insertTestVersion(tx, ["Noch nicht abgeglichen."], { sourceId: elsewhere });
      const [src] = await tx.select({ domain: sources.domain }).from(sources).where(eq(sources.id, found));
      const domain = src!.domain;
      const [q] = await tx
        .insert(serpQueries)
        .values({ keyword: `k-${newId()}`, languageCode: "de", locationCode: 2300, depth: 20, level: "tile", scopeId: tile, rawKey: `serp/x/${newId()}.json`, fetchedAt: new Date() })
        .returning({ id: serpQueries.id });
      await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url: `https://${domain}/`, urlNormalized: `https://${domain}/`, domain, title: "t", snippet: "s" });

      const tileRun = (await freezeTextRunParams(tx, { tileId: tile }, config)).documentVersionIds;
      expect(tileRun).toEqual(expect.arrayContaining([mentioned.versionId, pendingHere.versionId]));
      expect(tileRun).not.toContain(pendingElsewhere.versionId);
      const reprocess = (await freezeTextRunParams(tx, { tileId: tile, reprocess: true }, config)).documentVersionIds;
      expect(reprocess).toContain(mentioned.versionId);
      expect(reprocess).not.toContain(pendingHere.versionId);
    }));

  it("a subdivision run takes the versions mentioning objects in its scope tiles plus the pending versions of the sources its areas' searches found", () =>
    withRollback(async (tx) => {
      const sub = await insertTestSubdivision(tx, "XT-T1", [21.0, 35.0, 21.5, 35.25]);
      const { tile } = await islandTile(tx);
      await tx.update(tiles).set({ subdivisionId: sub.id }).where(eq(tiles.id, tile));
      const mentioned = await insertTestVersion(tx, ["Rund um Kalonisi."]);
      await matchVersion(tx, mentioned.versionId, { runId: null, cfg: config });
      // a source found by a search for an area touching the scope tile
      await insertNamedObject(tx, { type: "area", names: [{ name: "Testgolf" }], lon: 21.1, lat: 35.1, configKey: "xt-text-area", tiles: [tile] });
      const found = await insertTestSource(tx);
      const elsewhere = await insertTestSource(tx);
      const pendingHere = await insertTestVersion(tx, ["Noch nicht abgeglichen."], { sourceId: found });
      const pendingElsewhere = await insertTestVersion(tx, ["Noch nicht abgeglichen."], { sourceId: elsewhere });
      const [src] = await tx.select({ domain: sources.domain }).from(sources).where(eq(sources.id, found));
      const [q] = await tx
        .insert(serpQueries)
        .values({ keyword: `k-${newId()}`, languageCode: "de", locationCode: 2300, depth: 20, level: "area", scopeId: "xt-text-area", rawKey: `serp/x/${newId()}.json`, fetchedAt: new Date() })
        .returning({ id: serpQueries.id });
      await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url: `https://${src!.domain}/`, urlNormalized: `https://${src!.domain}/`, domain: src!.domain, title: "t", snippet: "s" });

      const run = (await freezeTextRunParams(tx, { subdivisionKey: "XT-T1" }, config)).documentVersionIds;
      expect(run).toEqual(expect.arrayContaining([mentioned.versionId, pendingHere.versionId]));
      expect(run).not.toContain(pendingElsewhere.versionId);
      const reprocess = (await freezeTextRunParams(tx, { subdivisionKey: "XT-T1", reprocess: true }, config)).documentVersionIds;
      expect(reprocess).toContain(mentioned.versionId);
      expect(reprocess).not.toContain(pendingHere.versionId);
      // another subdivision without those tiles takes none of them
      await insertTestSubdivision(tx, "XT-T2", [30.0, 36.0, 30.2, 36.1]);
      expect((await freezeTextRunParams(tx, { subdivisionKey: "XT-T2" }, config)).documentVersionIds).not.toContain(mentioned.versionId);
    }));

  it("a rematch with a configuration that makes a matched span ambiguous adds no waiting row over the mention", () =>
    withRollback(async (tx) => {
      const { tile } = await islandTile(tx);
      const vathy = await insertNamedObject(tx, { type: "bay", names: [{ name: "Vathy" }], lon: 21.15, lat: 35.15, tiles: [tile] });
      const v = await insertTestVersion(tx, ["Abends lagen wir vor Vathy auf Kalonisi."]);
      await matchVersion(tx, v.versionId, { runId: null, cfg: config });
      expect((await tx.select().from(mentions).where(eq(mentions.documentVersionId, v.versionId))).map((m) => m.geoObjectId)).toContain(vathy);
      const later: AppConfig = {
        ...config,
        mentions: { ...config.mentions, commonWords: { ...config.mentions.commonWords, en: [...(config.mentions.commonWords.en ?? []), "vathy"] } },
      };
      await matchVersion(tx, v.versionId, { runId: null, cfg: later });
      expect(await tx.select().from(ambiguousMatches).where(eq(ambiguousMatches.documentVersionId, v.versionId))).toEqual([]);
    }));
});
