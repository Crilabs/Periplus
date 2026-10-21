import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestRun, insertTestSubdivision, insertTestTile, insertTestVersion } from "@/test/text";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { mentions, runs, tileGeoObjects } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { tileIdFor } from "@/lib/domain/tiles";
import { mentionsRereadStage } from "@/lib/jobs/handlers/reread";
import { mentionsRereadHandler } from "@/lib/jobs/handlers/reread-start";
import type { JobContext } from "@/lib/jobs/worker";
import { SUBDIVISION_BUILD_STAGES } from "@/lib/pipeline/subdivision-build";
import { GAZETTEER_STAGES } from "@/lib/pipeline/gazetteer/stages";
import { matchVersions, planMentions } from "@/lib/pipeline/text/mentions";
import { prefilteredVersions, prefilterNames, rereadVersions } from "@/lib/pipeline/text/reread";
import { startRereadRun, TEXT_RUN_STAGES } from "@/lib/pipeline/text/run";

/*
 * Spec 14 „Nachlesen beim Start eines Landesteils“, in withRollback with a recording job queue: a trip report found for
 * subdivision A names a gulf and a bay that only B's gazetteer knows; after B's gazetteer the re-read run matches it.
 */

const config = loadConfig("config");

function recordingBoss() {
  const inserted: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const boss = {
    insert: async (queue: string, jobs: Array<{ id?: string; data: Record<string, unknown> }>) => {
      inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
      return jobs.map((j) => j.id ?? newId());
    },
  } as unknown as PgBoss;
  return { boss, inserted };
}

const TILE_A = tileIdFor(52.1, 31.1);
const TILE_B = tileIdFor(53.1, 31.1);

/** Subdivision A with its tile, the gulf (in A) and a report naming gulf and bay; B exists but is not built. */
async function scene(tx: Db) {
  const a = await insertTestSubdivision(tx, "XT-RA", [52.0, 31.0, 52.25, 31.25]);
  const b = await insertTestSubdivision(tx, "XT-RB", [53.0, 31.0, 53.25, 31.25]);
  await insertTestTile(tx, TILE_A, null, a.id);
  const gulf = await insertNamedObject(tx, { type: "gulf", names: [{ name: "Zorbos Gulf" }], lon: 52.1, lat: 31.1, tiles: [TILE_A] });
  const report = await insertTestVersion(tx, ["We sailed across the Zorbos Gulf and anchored in Palmira Bay for the night."]);
  const unrelatedIsland = await insertNamedObject(tx, { type: "island", names: [{ name: "Wolkeninsel" }], lon: 52.15, lat: 31.15, tiles: [TILE_A] });
  const unrelated = await insertTestVersion(tx, ["Rund um Wolkeninsel ist es ruhig."]);
  const runId = await insertTestRun(tx);
  const match = (v: string) => matchVersions(tx, { runId, versionIds: [v] }, config);
  await match(report.versionId);
  await match(unrelated.versionId);
  return { a, b, gulf, unrelatedIsland, report, unrelated, match };
}

/** B's gazetteer: its tile, the bay in it, and the gulf reaching the tile. */
async function buildB(tx: Db, s: Awaited<ReturnType<typeof scene>>) {
  await insertTestTile(tx, TILE_B, null, s.b.id);
  const bay = await insertNamedObject(tx, { type: "bay", names: [{ name: "Palmira Bay" }], lon: 53.1, lat: 31.1, tiles: [TILE_B], subdivisionId: s.b.id });
  await tx.insert(tileGeoObjects).values({ tileId: TILE_B, geoObjectId: s.gulf }).onConflictDoNothing();
  return bay;
}

const bayMentions = (tx: Db, versionId: string, bay: string) =>
  tx.select({ id: mentions.id }).from(mentions).where(and(eq(mentions.documentVersionId, versionId), eq(mentions.geoObjectId, bay)));

describe("mentions re-read", () => {
  it("has the stage after the gazetteer stages and the Revier import in a build, as one job on its own queue", async () => {
    const stages: readonly string[] = SUBDIVISION_BUILD_STAGES;
    expect(stages.indexOf("mentions.reread")).toBeGreaterThan(GAZETTEER_STAGES.length - 1);
    expect(stages.indexOf("mentions.reread")).toBe(stages.indexOf("areas.import") + 1);
    expect(mentionsRereadStage).toMatchObject({ name: "mentions.reread", queue: "mentions.reread" });
    expect(await mentionsRereadStage.plan({} as never, { id: "r", params: { subdivisionKey: "XT-RB" } })).toEqual([{ key: "XT-RB", subdivisionKey: "XT-RB" }]);
  });

  it("selects only documents whose prepass touches a tile of the subdivision", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      expect(await rereadVersions(tx, "XT-RB", config)).toEqual([]);
      await buildB(tx, s);
      expect(await rereadVersions(tx, "XT-RB", config)).toEqual([s.report.versionId]);
    }));

  it("starts a reprocess run that adds the bay's mention; a second build adds no duplicate; no versions, no run", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const bay = await buildB(tx, s);
      expect(await bayMentions(tx, s.report.versionId, bay)).toEqual([]);

      const rec = recordingBoss();
      const ctx = { db: tx, boss: rec.boss, log: { info: () => undefined } } as unknown as JobContext;
      await mentionsRereadHandler({ key: "XT-RB", subdivisionKey: "XT-RB", runId: await insertTestRun(tx), stage: "mentions.reread" }, ctx);
      const [run] = await tx.select().from(runs).where(and(eq(runs.kind, "reprocess"), eq(runs.scopeId, "XT-RB")));
      expect(run).toMatchObject({
        scopeType: "subdivision",
        stages: [...TEXT_RUN_STAGES],
        params: expect.objectContaining({ subdivisionKey: "XT-RB", documentVersionIds: [s.report.versionId], rematch: true }),
      });
      expect(rec.inserted.map((i) => i.data.runId)).toEqual([run!.id]);

      // the run's mentions stage plans the version and matches it
      const jobs = await planMentions(tx, { id: run!.id, params: run!.params as Record<string, unknown> }, config);
      for (const job of jobs) await matchVersions(tx, job as never, config);
      const first = await bayMentions(tx, s.report.versionId, bay);
      expect(first).toHaveLength(1);

      // „Aufbauen“ again: the same selection, the same mention
      const second = await startRereadRun(tx, rec.boss, { subdivisionKey: "XT-RB", documentVersionIds: await rereadVersions(tx, "XT-RB", config), triggeredBy: "system" });
      const [again] = await tx.select().from(runs).where(eq(runs.id, second!.id));
      for (const job of await planMentions(tx, { id: again!.id, params: again!.params as Record<string, unknown> }, config)) await matchVersions(tx, job as never, config);
      expect(await bayMentions(tx, s.report.versionId, bay)).toEqual(first);

      expect(await startRereadRun(tx, rec.boss, { subdivisionKey: "XT-RB", documentVersionIds: [], triggeredBy: "system" })).toBeNull();
    }));

  it("the handler starts no run when no document touches the subdivision", () =>
    withRollback(async (tx) => {
      await scene(tx);
      await insertTestTile(tx, TILE_B, null, (await tx.query.subdivisions.findFirst({ where: (t, { eq: e }) => e(t.key, "XT-RB") }))!.id);
      const rec = recordingBoss();
      const ctx = { db: tx, boss: rec.boss, log: { info: () => undefined } } as unknown as JobContext;
      await mentionsRereadHandler({ key: "XT-RB", subdivisionKey: "XT-RB", runId: await insertTestRun(tx), stage: "mentions.reread" }, ctx);
      expect(await tx.select().from(runs).where(and(eq(runs.kind, "reprocess"), eq(runs.scopeId, "XT-RB")))).toEqual([]);
      expect(rec.inserted).toEqual([]);
    }));

  it("leaves out pending (never matched) versions", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      await buildB(tx, s);
      const pending = await insertTestVersion(tx, ["Noch nicht ausgewertet: Zorbos Gulf."]);
      expect(await rereadVersions(tx, "XT-RB", config)).toEqual([s.report.versionId]);
      await s.match(pending.versionId);
      expect(await rereadVersions(tx, "XT-RB", config)).toEqual([s.report.versionId, pending.versionId].sort());
    }));

  it("takes a document whose prepass tiles only neighbour the subdivision's tile (ring)", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      await buildB(tx, s);
      const neighbour = tileIdFor(53.35, 31.1);
      await insertTestTile(tx, neighbour);
      await insertNamedObject(tx, { type: "gulf", names: [{ name: "Kerpa Gulf" }], lon: 53.35, lat: 31.1, tiles: [neighbour] });
      const near = await insertTestVersion(tx, ["Der Kerpa Gulf liegt gleich nebenan."]);
      await s.match(near.versionId);
      expect(await rereadVersions(tx, "XT-RB", config)).toContain(near.versionId);
    }));

  it("prefilters by the names around the subdivision before the prepass (accents, punctuation, greek script folded in)", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      await buildB(tx, s);
      const names = await prefilterNames(tx, [TILE_B], config);
      expect(names).toEqual(expect.arrayContaining(["zorbos gulf"]));
      expect(names).not.toContain("palmira bay"); // a bay is no prepass type
      expect(names).not.toContain("wolkeninsel");
      const accent = await insertTestVersion(tx, ["Im Zórbos-Gulf, dann weiter."]);
      for (const [name, text] of [["Muğla", "Hafen von Muğla im Süden"], ["Ċirkewwa", "Die Fähre ab Ċirkewwa fährt oft"], ["Ġnejna", "Ankern in Ġnejna Bay"]] as const) {
        await insertNamedObject(tx, { type: "island", names: [{ name }], lon: 53.1, lat: 31.1, tiles: [TILE_B] });
        const v = await insertTestVersion(tx, [text]);
        await s.match(v.versionId);
        expect(await prefilteredVersions(tx, await prefilterNames(tx, [TILE_B], config))).toContain(v.versionId);
      }
      const greek = await insertTestVersion(tx, ["Ο κόλπος."]);
      const plainText = await insertTestVersion(tx, ["Nothing about any known place here."]);
      for (const v of [accent, greek, plainText]) await s.match(v.versionId);
      const kept = await prefilteredVersions(tx, names);
      expect(kept).toEqual(expect.arrayContaining([s.report.versionId, accent.versionId, greek.versionId]));
      expect(kept).not.toContain(s.unrelated.versionId);
      expect(kept).not.toContain(plainText.versionId);
    }));

  it("a retry of the stage for the same build run starts one run", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      await buildB(tx, s);
      const rec = recordingBoss();
      const ctx = { db: tx, boss: rec.boss, log: { info: () => undefined } } as unknown as JobContext;
      const job = { key: "XT-RB", subdivisionKey: "XT-RB", runId: await insertTestRun(tx), stage: "mentions.reread" };
      await mentionsRereadHandler(job, ctx);
      await mentionsRereadHandler(job, ctx);
      const started = await tx.select().from(runs).where(and(eq(runs.kind, "reprocess"), eq(runs.scopeId, "XT-RB")));
      expect(started).toHaveLength(1);
      expect(started[0]!.params).toMatchObject({ buildRunId: job.runId });
    }));
});
