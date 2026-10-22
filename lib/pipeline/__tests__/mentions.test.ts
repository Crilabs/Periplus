import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestRun, insertTestTile, insertTestVersion } from "@/test/text";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { ambiguousMatches, documents, mentions, pipelinePasses, placeWebsites, unmatchedNames, type GeoObjectType } from "@/lib/db/schema";
import { insertPlace } from "@/test/consolidation";
import { planUnits } from "@/lib/domain/extraction/units";
import { mentionsConfigKey } from "@/lib/domain/mentions/store";
import { createRun } from "@/lib/domain/runs";
import { newId } from "@/lib/domain/ids";
import { MENTIONS_STAGE, matchVersion, matchVersions, planMentions } from "@/lib/pipeline/text/mentions";

/*
 * The fixture texts (de/en/el) against the synthetic fixture gazetteer, always in withRollback.
 */

const config: AppConfig = loadConfig("config");
const DIR = join(process.cwd(), "test/fixtures/texts");
const FILES = ["de-trip-report.md", "en-pilot-guide.md", "el-forum.md"] as const;

type Gazetteer = {
  tiles: string[];
  objects: Array<{
    key: string;
    type: GeoObjectType;
    names: Array<{ name: string; language: string }>;
    lon: number;
    lat: number;
    tiles: string[];
    parent?: string;
  }>;
};
type Expected = {
  documents: Record<
    string,
    { mentions: Array<[string, string]>; ambiguous: Array<[string, string[]]>; unmatched: Array<[string, string, string]> }
  >;
};

const gazetteer = JSON.parse(readFileSync(join(DIR, "gazetteer.json"), "utf8")) as Gazetteer;
const expected = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8")) as Expected;
/** A fixture text's chunks: its paragraphs. */
const chunksOf = (file: string) => readFileSync(join(DIR, file), "utf8").trim().split(/\n\s*\n/);

/** The fixture gazetteer; returns object id by key. */
async function loadGazetteer(tx: Db): Promise<Map<string, string>> {
  for (const t of gazetteer.tiles) await insertTestTile(tx, t);
  const ids = new Map<string, string>();
  for (const o of gazetteer.objects) {
    ids.set(o.key, await insertNamedObject(tx, { ...o, parentId: o.parent ? ids.get(o.parent)! : null }));
  }
  return ids;
}

async function rowsOf(tx: Db, versionIds: string[]) {
  const ms = await tx.select().from(mentions).where(inArray(mentions.documentVersionId, versionIds));
  const amb = await tx.select().from(ambiguousMatches).where(inArray(ambiguousMatches.documentVersionId, versionIds));
  const un = await tx.select().from(unmatchedNames).where(inArray(unmatchedNames.documentVersionId, versionIds));
  return { ms, amb, un };
}

/** Rows in text order: chunk ordinal (the chunk's position in `chunkIds`), then offset. */
const textOrder = (chunkIds: string[]) => (a: { chunkId: string; charStart: number }, b: { chunkId: string; charStart: number }) =>
  chunkIds.indexOf(a.chunkId) - chunkIds.indexOf(b.chunkId) || a.charStart - b.charStart;

describe("stage mentions.batch", () => {
  it("fixture documents yield exactly the expected mentions, ambiguities and unmatched names", () =>
    withRollback(async (tx) => {
      const ids = await loadGazetteer(tx);
      const keyOf = new Map([...ids].map(([k, v]) => [v, k]));
      const runId = await insertTestRun(tx);
      for (const file of FILES) {
        const v = await insertTestVersion(tx, chunksOf(file));
        await matchVersion(tx, v.versionId, { runId, cfg: config });
        const { ms, amb, un } = await rowsOf(tx, [v.versionId]);
        const want = expected.documents[file]!;
        expect(ms.sort(textOrder(v.chunkIds)).map((m) => [m.surface, keyOf.get(m.geoObjectId)]), file).toEqual(want.mentions);
        expect(
          amb.sort(textOrder(v.chunkIds)).map((a) => [a.surface, (a.candidates as Array<{ geoObjectId: string }>).map((c) => keyOf.get(c.geoObjectId)).sort()]),
          file,
        ).toEqual(want.ambiguous.map(([s, keys]) => [s, [...keys].sort()]));
        const unmatched = un.sort((a, b) => v.chunkIds.indexOf(a.chunkId) - v.chunkIds.indexOf(b.chunkId) || a.displayName.localeCompare(b.displayName));
        expect(unmatched.map((u) => [u.displayName, u.hint, u.tileId]), file).toEqual(want.unmatched);
        // offsets point into the chunk text
        const texts = chunksOf(file);
        for (const m of ms) expect(texts[v.chunkIds.indexOf(m.chunkId)]!.slice(m.charStart, m.charEnd)).toBe(m.surface);
        const [pass] = await tx.select().from(pipelinePasses).where(eq(pipelinePasses.documentVersionId, v.versionId));
        expect(pass).toMatchObject({ stage: MENTIONS_STAGE, configKey: mentionsConfigKey(config), runId });
      }
    }));

  it("carried chunks are not matched again", () =>
    withRollback(async (tx) => {
      await loadGazetteer(tx);
      const runId = await insertTestRun(tx);
      const texts = chunksOf("en-pilot-guide.md");
      const v1 = await insertTestVersion(tx, texts);
      await matchVersion(tx, v1.versionId, { runId, cfg: config });
      const v2 = await insertTestVersion(tx, [...texts, "Ermioni again, and Kalonisi."], {
        documentId: v1.documentId,
        sourceId: v1.sourceId,
        carried: Object.fromEntries(v1.chunkIds.map((id, i) => [i, id])),
      });
      const counts = await matchVersion(tx, v2.versionId, { runId, cfg: config });
      expect(counts).toEqual({ mentions: 2, ambiguous: 0, unmatched: 0, chunks: 1 });
      const { ms, amb, un } = await rowsOf(tx, [v2.versionId]);
      expect(new Set([...ms, ...amb, ...un].map((r) => r.chunkId))).toEqual(new Set([v2.chunkIds[3]]));
      expect(ms.map((m) => m.surface).sort()).toEqual(["Ermioni", "Kalonisi"]);
    }));

  it("a second pass adds nothing", () =>
    withRollback(async (tx) => {
      await loadGazetteer(tx);
      const runId = await insertTestRun(tx);
      const versions = [];
      for (const file of FILES) versions.push((await insertTestVersion(tx, chunksOf(file))).versionId);
      const first = await matchVersions(tx, { runId, versionIds: versions }, config);
      expect(first.mentions).toBeGreaterThan(0);
      const before = await rowsOf(tx, versions);
      expect(await matchVersions(tx, { runId, versionIds: versions }, config)).toEqual({ ...first, mentions: 0, ambiguous: 0, unmatched: 0 });
      const after = await rowsOf(tx, versions);
      expect([after.ms.length, after.amb.length, after.un.length]).toEqual([before.ms.length, before.amb.length, before.un.length]);
      expect(await tx.select().from(pipelinePasses).where(inArray(pipelinePasses.documentVersionId, versions))).toHaveLength(3);
    }));

  it("at least 70 % of the fixture mentions need no model", () =>
    withRollback(async (tx) => {
      await loadGazetteer(tx);
      const runId = await insertTestRun(tx);
      const versions = [];
      for (const file of FILES) versions.push((await insertTestVersion(tx, chunksOf(file))).versionId);
      await matchVersions(tx, { runId, versionIds: versions }, config);
      const { ms, amb } = await rowsOf(tx, versions);
      const share = ms.length / (ms.length + amb.length);
      expect(share).toBeGreaterThan(0.7);
    }));

  it("the plan cuts the run's versions into jobs of versionsPerJob", () =>
    withRollback(async (tx) => {
      const versions = [];
      for (let i = 0; i < 5; i++) versions.push((await insertTestVersion(tx, ["Text."])).versionId);
      const { id } = await createRun(tx, {
        kind: "reprocess",
        scope: { type: "system", id: `mentions-test-${newId()}` },
        stages: [MENTIONS_STAGE],
        params: { documentVersionIds: versions },
        triggeredBy: "test",
      });
      const small: AppConfig = { ...config, mentions: { ...config.mentions, versionsPerJob: 2 } };
      const jobs = await planMentions(tx, { id, params: { documentVersionIds: versions } }, small);
      const sorted = [...versions].sort();
      expect(jobs).toEqual([
        { key: "mentions:0", versionIds: sorted.slice(0, 2) },
        { key: "mentions:1", versionIds: sorted.slice(2, 4) },
        { key: "mentions:2", versionIds: sorted.slice(4) },
      ]);
    }));

  describe("bound mentions (spec 16 C)", () => {
    /** A page at `url` of a version with the given chunk texts; its document is the one `insertTestVersion` made. */
    async function pageAt(tx: Db, url: string, texts: string[]) {
      const v = await insertTestVersion(tx, texts);
      await tx.update(documents).set({ url, urlNormalized: url }).where(eq(documents.id, v.documentId));
      return v;
    }
    const website = (tx: Db, p: { placeId: string; objectId: string }, url: string, bound = true) =>
      tx.insert(placeWebsites).values({ placeId: p.placeId, geoObjectId: p.objectId, url, urlNormalized: url, origin: "osm", bound });
    const texts = Array.from({ length: 8 }, (_, i) => `Fuel is available at the quay, part ${i}.`);

    it("a page under a bound start URL gets one zero-length bound mention per chunk, without the name", () =>
      withRollback(async (tx) => {
        const runId = await insertTestRun(tx);
        const place = await insertPlace(tx, { type: "harbour", name: "Marina Alpha" });
        const host = `https://${newId()}.example`;
        await website(tx, place, `${host}/en/`);
        const v = await pageAt(tx, `${host}/en/services`, texts);
        const counts = await matchVersion(tx, v.versionId, { runId, cfg: config });
        expect(counts.mentions).toBe(8);
        const ms = await tx.select().from(mentions).where(eq(mentions.documentVersionId, v.versionId));
        expect(ms.map((m) => m.chunkId).sort()).toEqual([...v.chunkIds].sort());
        for (const m of ms) {
          expect(m).toMatchObject({ geoObjectId: place.objectId, surface: "", charStart: 0, charEnd: 0, confidence: 1, matchKind: "bound", typeHint: null, observedAt: "2026-10-19", runId });
        }
        // one unit over all chunks: two parts of at most maxChunksPerUnit (6) for 8 chunks
        const { units } = await planUnits(tx, ms.map((m) => m.id), config.extraction.unit);
        expect(units.map((u) => u.chunkIds.length)).toEqual([6, 4]);
      }));

    it("a chain's page under another place's start URL is bound to that place", () =>
      withRollback(async (tx) => {
        const runId = await insertTestRun(tx);
        const chain = await insertPlace(tx, { type: "harbour", name: "Chain HQ" });
        const local = await insertPlace(tx, { type: "harbour", name: "Local Marina" });
        const host = `https://${newId()}.example`;
        await website(tx, chain, `${host}/`);
        await website(tx, local, `${host}/marinas/local/`);
        const v = await pageAt(tx, `${host}/marinas/local/fuel`, ["Fuel quay."]);
        await matchVersion(tx, v.versionId, { runId, cfg: config });
        const ms = await tx.select().from(mentions).where(eq(mentions.documentVersionId, v.versionId));
        expect(ms.map((m) => [m.geoObjectId, m.matchKind])).toEqual([[local.objectId, "bound"]]);
      }));

    it("a start URL shared by several places (bound = false) binds no mention", () =>
      withRollback(async (tx) => {
        const runId = await insertTestRun(tx);
        const a = await insertPlace(tx, { type: "harbour", name: "Alpha" });
        const host = `https://${newId()}.example`;
        await website(tx, a, `${host}/`, false);
        const v = await pageAt(tx, `${host}/x`, ["Fuel quay."]);
        expect(await matchVersion(tx, v.versionId, { runId, cfg: config })).toMatchObject({ mentions: 0 });
        expect(await tx.select().from(mentions).where(eq(mentions.documentVersionId, v.versionId))).toEqual([]);
      }));

    it("a rematch adds no second bound mention", () =>
      withRollback(async (tx) => {
        const runId = await insertTestRun(tx);
        const place = await insertPlace(tx, { type: "harbour", name: "Marina Alpha" });
        const host = `https://${newId()}.example`;
        await website(tx, place, `${host}/`);
        const v = await pageAt(tx, `${host}/x`, texts.slice(0, 3));
        await matchVersion(tx, v.versionId, { runId, cfg: config });
        expect(await matchVersion(tx, v.versionId, { runId, cfg: config })).toMatchObject({ mentions: 0 });
        expect(await matchVersion(tx, v.versionId, { runId, cfg: config, rematch: true })).toMatchObject({ mentions: 0 });
        expect(await tx.select().from(mentions).where(eq(mentions.documentVersionId, v.versionId))).toHaveLength(3);
      }));
  });
});
