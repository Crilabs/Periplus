import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { quietDay } from "@/test/external-calls";
import { insertNamedObject, insertTestRun, insertTestSubdivision, insertTestTile, insertTestVersion } from "@/test/text";
import { MockModel } from "@/lib/ai/mock";
import { candidateList, disambiguateMentionTask, type DisambiguateMentionInput } from "@/lib/ai/tasks/disambiguate-mention";
import { disambiguationInputs } from "@/lib/pipeline/text/disambiguate";
import { buildParams } from "@/lib/ai/anthropic";
import { getConfig, loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, ambiguousMatches, geoObjects, mentions, runs } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun } from "@/lib/domain/runs";
import { tileIdFor } from "@/lib/domain/tiles";
import { pollBatch } from "@/lib/pipeline/batches";
import {
  applyDisambiguation,
  DISAMBIGUATE_STAGE,
  disambiguateMatches,
  disambiguationBatchEntry,
  disambiguationInput,
  markedContext,
  planDisambiguate,
} from "@/lib/pipeline/text/disambiguate";
import { matchVersion } from "@/lib/pipeline/text/mentions";
import { startTextRun } from "@/lib/pipeline/text/run";
import { freezeTextRunParams } from "@/lib/pipeline/text/versions";

const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };
const A = tileIdFor(21.1, 35.1);
const B = tileIdFor(21.3, 35.1);
const META = { model: "claude-haiku-5-5", promptVersion: 1 };
const TEXT = "Von Kalonisi weiter nach Vathy, dort ankerten wir.";

function recordingBoss() {
  const inserted: Array<{ queue: string; id?: string; data: Record<string, unknown> }> = [];
  const boss = {
    insert: async (queue: string, jobs: Array<{ id?: string; data: Record<string, unknown> }>) => {
      const fresh = jobs.filter((j) => !inserted.some((i) => i.id !== undefined && i.id === j.id));
      for (const job of fresh) inserted.push({ queue, ...job });
      return fresh.map((j) => j.id ?? newId());
    },
  } as unknown as PgBoss;
  return { boss, inserted };
}

/** An island with two same-named bays "Vathy" (one in a neighbour tile), a matched text and its ambiguous match. */
async function scene(tx: Db) {
  const area = await insertNamedObject(tx, { type: "area", names: [{ name: "Testrevier" }], lon: 21.2, lat: 35.2 });
  for (const t of [A, B]) await insertTestTile(tx, t, area);
  const kalonisi = await insertNamedObject(tx, { type: "island", names: [{ name: "Kalonisi" }], lon: 21.12, lat: 35.12, tiles: [A], parentId: area });
  const vathyA = await insertNamedObject(tx, { type: "bay", names: [{ name: "Vathy" }], lon: 21.1, lat: 35.1, tiles: [A], parentId: kalonisi });
  const vathyB = await insertNamedObject(tx, { type: "harbour", names: [{ name: "Vathy" }], lon: 21.3, lat: 35.15, tiles: [B] });
  const runId = await insertTestRun(tx);
  const v = await insertTestVersion(tx, [TEXT]);
  await matchVersion(tx, v.versionId, { runId, cfg: config });
  const [amb] = await tx.select().from(ambiguousMatches).where(eq(ambiguousMatches.documentVersionId, v.versionId));
  const candidates = amb!.candidates as Array<{ geoObjectId: string; similarity: number }>;
  return { area, kalonisi, vathyA, vathyB, runId, versionId: v.versionId, chunkId: v.chunkIds[0]!, amb: amb!, candidates };
}

async function mentionsOf(tx: Db, versionId: string) {
  return tx.select().from(mentions).where(eq(mentions.documentVersionId, versionId));
}

async function status(tx: Db, id: string) {
  const [row] = await tx.select({ status: ambiguousMatches.status }).from(ambiguousMatches).where(eq(ambiguousMatches.id, id));
  return row!.status;
}

describe("applyDisambiguation", () => {
  it("choice 2 creates a model mention of the second candidate", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      expect(s.candidates).toHaveLength(2);
      expect(await applyDisambiguation(tx, s.amb.id, { choice: 2, confidence: 0.8 }, { ...META, runId: s.runId })).toBe("mention");
      const model = (await mentionsOf(tx, s.versionId)).filter((m) => m.matchKind === "model");
      expect(model).toHaveLength(1);
      expect(model[0]).toMatchObject({
        geoObjectId: s.candidates[1]!.geoObjectId,
        chunkId: s.chunkId,
        surface: "Vathy",
        charStart: TEXT.indexOf("Vathy"),
        charEnd: TEXT.indexOf("Vathy") + 5,
        confidence: 0.8,
        matchScore: s.candidates[1]!.similarity,
        model: "claude-haiku-5-5",
        promptVersion: 1,
        runId: s.runId,
        observedAt: "2026-10-19",
      });
      expect(await status(tx, s.amb.id)).toBe("resolved");
    }));

  it("choice 0 creates nothing and marks the match none", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      expect(await applyDisambiguation(tx, s.amb.id, { choice: 0, confidence: 0 }, { ...META, runId: s.runId })).toBe("none");
      expect((await mentionsOf(tx, s.versionId)).filter((m) => m.matchKind === "model")).toEqual([]);
      expect(await status(tx, s.amb.id)).toBe("none");
    }));

  it("a choice outside the candidates is treated as none", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      expect(await applyDisambiguation(tx, s.amb.id, { choice: 3, confidence: 0.9 }, { ...META, runId: s.runId })).toBe("none");
      expect((await mentionsOf(tx, s.versionId)).filter((m) => m.matchKind === "model")).toEqual([]);
      expect(await status(tx, s.amb.id)).toBe("none");
    }));

  it("applying the same answer twice creates one mention", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      for (let i = 0; i < 2; i++) {
        expect(await applyDisambiguation(tx, s.amb.id, { choice: 1, confidence: 0.7 }, { ...META, runId: s.runId })).toBe("mention");
      }
      expect((await mentionsOf(tx, s.versionId)).filter((m) => m.matchKind === "model")).toHaveLength(1);
      // a later, different answer does not overturn the first decision
      expect(await applyDisambiguation(tx, s.amb.id, { choice: 0, confidence: 0 }, { ...META, runId: s.runId })).toBe("mention");
      expect(await status(tx, s.amb.id)).toBe("resolved");
    }));
});

describe("applyDisambiguation with a changed gazetteer", () => {
  it("a chosen candidate that was merged or ended since the match gives none", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const [first, second] = s.candidates.map((c) => c.geoObjectId);
      await tx.update(geoObjects).set({ mergedIntoId: second }).where(eq(geoObjects.id, first!));
      expect(await applyDisambiguation(tx, s.amb.id, { choice: 1, confidence: 0.9 }, { ...META, runId: s.runId })).toBe("none");
      expect((await mentionsOf(tx, s.versionId)).filter((m) => m.matchKind === "model")).toEqual([]);
      expect(await status(tx, s.amb.id)).toBe("none");

      // a second match of the same span shape whose chosen candidate has ended
      const again = await insertTestVersion(tx, [TEXT]);
      const [t] = await tx
        .insert(ambiguousMatches)
        .values({ documentVersionId: again.versionId, chunkId: again.chunkIds[0]!, surface: "Vathy", charStart: s.amb.charStart, charEnd: s.amb.charEnd, candidates: s.candidates })
        .returning({ id: ambiguousMatches.id });
      await tx.update(geoObjects).set({ validTo: "2026-01-01" }).where(eq(geoObjects.id, second!));
      expect(await applyDisambiguation(tx, t!.id, { choice: 2, confidence: 0.9 }, { ...META, runId: s.runId })).toBe("none");
      expect(await status(tx, t!.id)).toBe("none");
    }));
});

describe("disambiguation input", () => {
  it("coordinates carry their hemisphere", () => {
    const list = candidateList([
      { n: 1, name: "West", type: "bay", parents: [], lon: -4.25, lat: -33.5 },
      { n: 2, name: "Ost", type: "bay", parents: [], lon: 21.1, lat: 35.1 },
    ]);
    expect(list).toBe("1. West (bay) – 33.50000 S, 4.25000 W\n2. Ost (bay) – 35.10000 N, 21.10000 E");
  });

  it("a match whose candidate is missing is left out of the batch, the others go", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      const broken = await insertTestVersion(tx, ["Nochmal nach Vathy."]);
      const [bad] = await tx
        .insert(ambiguousMatches)
        .values({
          documentVersionId: broken.versionId,
          chunkId: broken.chunkIds[0]!,
          surface: "Vathy",
          charStart: 13,
          charEnd: 18,
          candidates: [{ geoObjectId: newId(), similarity: 1 }, ...s.candidates],
        })
        .returning({ id: ambiguousMatches.id });
      const inputs = await disambiguationInputs(tx, [bad!.id, s.amb.id, newId()], config);
      expect([...inputs.keys()]).toEqual([s.amb.id]);
      const model = new MockModel({ "disambiguate-mention": () => ({ choice: 1, confidence: 0.9 }) });
      const { boss } = recordingBoss();
      const { id: runId } = await createRun(tx, { kind: "stage", scope: { type: "system", id: `d-${newId()}` }, stages: [DISAMBIGUATE_STAGE], params: {}, triggeredBy: "test" });
      await beginStage(tx, runId, DISAMBIGUATE_STAGE, 1);
      const deps = { model, boss, config, now: () => now, reservationScope: { runIds: [runId] } };
      const job = { runId, stage: DISAMBIGUATE_STAGE, key: "disambiguate:0", ambiguousIds: [bad!.id, s.amb.id] };
      expect(await disambiguateMatches(tx, deps, job)).toEqual({ submitted: 1, remainder: 0, reused: false });
    }));

  it("the input lists every candidate with type, parents and coordinate", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const input = await disambiguationInput(tx, s.amb.id, config);
      expect(input.surface).toBe("Vathy");
      expect(input.chunk).toBe("Von Kalonisi weiter nach [[Vathy]], dort ankerten wir.");
      const byId = new Map([
        [s.vathyA, { type: "bay", parents: ["Kalonisi", "Testrevier"], lon: 21.1, lat: 35.1 }],
        [s.vathyB, { type: "harbour", parents: [], lon: 21.3, lat: 35.15 }],
      ]);
      expect(input.candidates.map((c) => c.n)).toEqual([1, 2]);
      for (const [i, c] of input.candidates.entries()) {
        const want = byId.get(s.candidates[i]!.geoObjectId)!;
        expect(c).toMatchObject({ name: "Vathy", type: want.type, parents: want.parents });
        expect(c.lon).toBeCloseTo(want.lon, 6);
        expect(c.lat).toBeCloseTo(want.lat, 6);
      }
      // the prompt gets the numbered list
      const params = buildParams(disambiguateMentionTask, input, config.models.tasks["disambiguate-mention"]!, "claude-haiku-5-5");
      const user = params.messages[0]!.content as string;
      expect(user).toContain("[[Vathy]]");
      expect(user).toContain(candidateList(input.candidates));
      expect(candidateList(input.candidates)).toMatch(/^1\. Vathy \((bay|harbour)\)/);
    }));

  it("a long chunk is cut to the configured context around the marked name", () => {
    const text = `${"a".repeat(5000)} Vathy ${"b".repeat(5000)}`;
    const start = text.indexOf("Vathy");
    const marked = markedContext(text, start, start + 5, 4000);
    expect(marked.replace("[[", "").replace("]]", "")).toHaveLength(4000);
    expect(marked).toContain("[[Vathy]]");
    expect(marked.indexOf("[[Vathy]]")).toBeGreaterThan(1900);
    expect(markedContext("kurz Vathy", 5, 10, 4000)).toBe("kurz [[Vathy]]");
    // at the start of a long chunk the window starts at 0
    expect(markedContext(`Vathy ${"c".repeat(5000)}`, 0, 5, 4000)).toMatch(/^\[\[Vathy\]\] c+$/);
  });
});

describe("stage mentions.disambiguate", () => {
  it("only pending ambiguous matches of the run go out; the poll creates the mention", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      const seen: DisambiguateMentionInput[] = [];
      const model = new MockModel({
        "disambiguate-mention": (input) => {
          seen.push(input as DisambiguateMentionInput);
          return { choice: 1, confidence: 0.9 };
        },
      });
      const { boss } = recordingBoss();
      // the match ran in an earlier run that has ended: the new run claims the pending match
      await tx.update(runs).set({ status: "finished" }).where(eq(runs.id, s.runId));
      const params = { documentVersionIds: [s.versionId] };
      const { id: runId } = await createRun(tx, {
        kind: "reprocess",
        scope: { type: "system", id: `disambiguate-test-${newId()}` },
        stages: [DISAMBIGUATE_STAGE],
        params,
        triggeredBy: "test",
      });
      const jobs = await planDisambiguate(tx, { id: runId, params }, config);
      expect(jobs).toEqual([{ key: "disambiguate:0", ambiguousIds: [s.amb.id] }]);
      await beginStage(tx, runId, DISAMBIGUATE_STAGE, jobs.length);
      const deps = { model, boss, config, now: () => now, reservationScope: { runIds: [runId] } };
      const job = { runId, stage: DISAMBIGUATE_STAGE, key: "disambiguate:0", ambiguousIds: [s.amb.id] };
      expect(await disambiguateMatches(tx, deps, job)).toEqual({ submitted: 1, remainder: 0, reused: false });
      expect(await disambiguateMatches(tx, deps, job)).toMatchObject({ reused: true });
      const batches = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      expect(batches).toHaveLength(1);
      expect(await pollBatch(tx, { ...deps, handlers: { "disambiguate-mention": disambiguationBatchEntry } }, batches[0]!.id)).toBe("distributed");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.candidates).toHaveLength(2);
      const model1 = (await mentionsOf(tx, s.versionId)).filter((m) => m.matchKind === "model");
      expect(model1.map((m) => [m.geoObjectId, m.runId])).toEqual([[s.candidates[0]!.geoObjectId, runId]]);
      expect(await status(tx, s.amb.id)).toBe("resolved");
      // nothing pending any more: a new plan is empty, and a late job with the decided match sends nothing
      expect(await planDisambiguate(tx, { id: runId, params }, config)).toEqual([]);
      expect(await disambiguateMatches(tx, deps, { ...job, key: "disambiguate:late" })).toEqual({ submitted: 0, remainder: 0, reused: false });
    }));

  it("a pending run plans the ambiguous matches its own match stage created (frozen version set)", () =>
    withRollback(async (tx) => {
      const area = await insertNamedObject(tx, { type: "area", names: [{ name: "Testrevier" }], lon: 21.2, lat: 35.2 });
      for (const t of [A, B]) await insertTestTile(tx, t, area);
      const kalonisi = await insertNamedObject(tx, { type: "island", names: [{ name: "Kalonisi" }], lon: 21.12, lat: 35.12, tiles: [A], parentId: area });
      await insertNamedObject(tx, { type: "bay", names: [{ name: "Vathy" }], lon: 21.1, lat: 35.1, tiles: [A], parentId: kalonisi });
      await insertNamedObject(tx, { type: "harbour", names: [{ name: "Vathy" }], lon: 21.3, lat: 35.15, tiles: [B] });
      const v = await insertTestVersion(tx, [TEXT]);
      // a re-resolved `pending` selection is refused by the stages
      await expect(planDisambiguate(tx, { id: newId(), params: { pending: true } }, config)).rejects.toThrow(/frozen version set/);
      const params = await freezeTextRunParams(tx, { pending: true }, config);
      expect(params.documentVersionIds).toContain(v.versionId);
      const { id: runId } = await createRun(tx, {
        kind: "stage",
        scope: { type: "system", id: `disambiguate-test-${newId()}` },
        stages: [DISAMBIGUATE_STAGE],
        params,
        triggeredBy: "test",
      });
      // the match stage writes the pass that makes the version no longer pending
      await matchVersion(tx, v.versionId, { runId, cfg: config });
      const [amb] = await tx.select().from(ambiguousMatches).where(eq(ambiguousMatches.documentVersionId, v.versionId));
      const jobs = await planDisambiguate(tx, { id: runId, params }, config);
      expect(jobs.flatMap((j) => j.ambiguousIds as string[])).toContain(amb!.id);
    }));

  it("startTextRun freezes the selection into the run's params", () =>
    withRollback(async (tx) => {
      const v = await insertTestVersion(tx, [TEXT]);
      const { boss } = recordingBoss();
      const { id } = await startTextRun(tx, boss, { documentVersionIds: [v.versionId], triggeredBy: "test" }, config);
      const [row] = await tx.select({ params: runs.params, stages: runs.stages }).from(runs).where(eq(runs.id, id));
      // the rules version active at the start is frozen too (ruling M7-E-R1)
      expect(row!.params).toEqual({ documentVersionIds: [v.versionId], rulesVersion: getConfig().consolidation.version });
      const pending = await startTextRun(tx, boss, { pending: true, triggeredBy: "test" }, config);
      const [p] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, pending.id));
      expect(p!.params).toMatchObject({ pending: true, documentVersionIds: expect.arrayContaining([v.versionId]) });
    }));

  it("overlapping runs never both plan the same pending match", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const params = { documentVersionIds: [s.versionId] };
      const other = await createRun(tx, { kind: "stage", scope: { type: "system", id: `d-${newId()}` }, stages: [DISAMBIGUATE_STAGE], params, triggeredBy: "test" });
      // the match belongs to the (active) run that matched it: another active run leaves it alone
      expect(await planDisambiguate(tx, { id: other.id, params }, config)).toEqual([]);
      const own = await planDisambiguate(tx, { id: s.runId, params }, config);
      expect(own).toEqual([{ key: "disambiguate:0", ambiguousIds: [s.amb.id] }]);
      // once the owner has ended, the other run claims it, and then the first one no longer plans it
      await tx.update(runs).set({ status: "failed" }).where(eq(runs.id, s.runId));
      expect(await planDisambiguate(tx, { id: other.id, params }, config)).toEqual([{ key: "disambiguate:0", ambiguousIds: [s.amb.id] }]);
      await tx.update(runs).set({ status: "running" }).where(eq(runs.id, s.runId));
      expect(await planDisambiguate(tx, { id: s.runId, params }, config)).toEqual([]);
      const [row] = await tx.select({ runId: ambiguousMatches.runId }).from(ambiguousMatches).where(eq(ambiguousMatches.id, s.amb.id));
      expect(row!.runId).toBe(other.id);
    }));

  it("a tile or subdivision selection resolves to the current versions mentioning objects there", () =>
    withRollback(async (tx) => {
      const key = `test-${newId()}`;
      const area = await insertNamedObject(tx, { type: "area", names: [{ name: "Testrevier" }], lon: 21.2, lat: 35.2, configKey: key });
      for (const t of [A, B]) await insertTestTile(tx, t, area);
      const kalonisi = await insertNamedObject(tx, { type: "island", names: [{ name: "Kalonisi" }], lon: 21.12, lat: 35.12, tiles: [A], parentId: area });
      const v = await insertTestVersion(tx, ["Rund um Kalonisi."]);
      await matchVersion(tx, v.versionId, { runId: null, cfg: config });
      expect((await mentionsOf(tx, v.versionId)).map((m) => m.geoObjectId)).toEqual([kalonisi]);
      expect((await freezeTextRunParams(tx, { tileId: A }, config)).documentVersionIds).toContain(v.versionId);
      expect((await freezeTextRunParams(tx, { tileId: B }, config)).documentVersionIds).not.toContain(v.versionId);
      // the subdivision's run scope is tile A only (its polygon lies inside A); tile B is not in it
      const subdivisionKey = `XT-${newId()}`;
      await insertTestSubdivision(tx, subdivisionKey, [21.02, 35.02, 21.2, 35.2]);
      expect((await freezeTextRunParams(tx, { subdivisionKey }, config)).documentVersionIds).toContain(v.versionId);
      const other = `XT-${newId()}`;
      await insertTestSubdivision(tx, other, [21.27, 35.02, 21.45, 35.2]);
      expect((await freezeTextRunParams(tx, { subdivisionKey: other }, config)).documentVersionIds).not.toContain(v.versionId);
    }));
});
