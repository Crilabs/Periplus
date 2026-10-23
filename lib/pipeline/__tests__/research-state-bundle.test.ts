import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { MockModel } from "@/lib/ai/mock";
import type { BundleFactsInput } from "@/lib/ai/tasks/bundle-facts";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, berthStates } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun } from "@/lib/domain/runs";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { pollBatch } from "@/lib/pipeline/batches";
import { bundleFactsBatchEntry, bundleFactsJob, planBundleFacts } from "@/lib/pipeline/research/state";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { seedPage, seedStatement } from "@/test/research-state";

const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };
const boss = { insert: async (_q: string, jobs: Array<{ id?: string }>) => jobs.map((j) => j.id ?? newId()) } as unknown as PgBoss;
const STAGE = "research.confirm"; // any registered stage: the stage of task 6 does not exist yet
const QUEUE = "research.confirm";

async function runWithStage(tx: Db): Promise<string> {
  const { id } = await createRun(tx, { kind: "reprocess", scope: { type: "system", id: `bundle-${newId()}` }, stages: [STAGE, "test.next"], triggeredBy: "test" });
  await beginStage(tx, id, STAGE, 1);
  return id;
}

/** Bundles the place's facts with `answer` (from the facts the model saw), polling until the batch is done. */
async function bundle(tx: Db, placeId: string, answer: (input: BundleFactsInput) => unknown, cfg: AppConfig = config) {
  const runId = await runWithStage(tx);
  const model = new MockModel({ "bundle-facts": (input) => answer(input as BundleFactsInput) }, { batchIdPrefix: `mock-${newId()}-` });
  const [job] = await planBundleFacts(tx, [placeId], cfg);
  const result = await bundleFactsJob(tx, { model, boss, config: cfg }, { runId, stage: STAGE, key: job!.key as string, placeIds: job!.placeIds as string[] }, QUEUE);
  // a retryable failure is resubmitted once as a follow-up batch of its own: poll until every batch of the run is done
  for (let round = 0; round < 4; round++) {
    for (const b of await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId))) await pollBatch(tx, { model, boss, config: cfg, handlers: BATCH_HANDLERS }, b.id);
  }
  const batches = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
  const [state] = await tx.select().from(berthStates).where(eq(berthStates.placeId, placeId));
  return { result, state, batches };
}

describe("fact bundling batch", () => {
  it("two equivalent facts of two domains become one fact with mentions 2", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const a = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "a.example" }), { statement: "Good holding in sand", observedAt: "2024-06-01" });
      const b = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "b.example" }), { statement: "Sand bottom, anchor holds well", observedAt: "2025-06-01" });
      const { result, state } = await bundle(tx, placeId, (input) => ({ groups: [{ ids: input.facts.map((f) => f.id), representative: b, superseded: [] }] }));
      expect(result).toMatchObject({ submitted: 1, reused: false });
      expect(BATCH_HANDLERS["bundle-facts"]).toBe(bundleFactsBatchEntry);
      expect(state!.facts).toEqual([expect.objectContaining({ factId: b, statement: "Sand bottom, anchor holds well", mentions: 2 })]);
      expect(state!.facts.map((f) => f.factId)).not.toContain(a);
      expect(state).toMatchObject({ core: {}, gaps: [], landing: [], nearby: [] });
    }));

  it("a newer closed fact supersedes the older good one: only the newer is in the state", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const spot = { subjectName: "Taverna Nikos", subjectCategory: "food" };
      const old = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "a.example" }), { statement: "Good taverna", observedAt: "2019-07-01", tone: "positive", ...spot });
      const now = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "b.example" }), { statement: "Taverna closed", observedAt: "2025-07-01", tone: "negative", ...spot });
      const { state } = await bundle(tx, placeId, () => ({ groups: [{ ids: [old, now], representative: now, superseded: [old] }] }));
      expect(state!.facts).toEqual([expect.objectContaining({ factId: now, statement: "Taverna closed", tone: "negative", mentions: 1, subject: "landside" })]);
    }));

  it("a broken answer (ids made up) stores the facts one by one", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "a.example" }), { statement: "One" });
      await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "b.example" }), { statement: "Two" });
      const { state } = await bundle(tx, placeId, () => ({ groups: [{ ids: ["nope", "nada"], representative: "nope", superseded: [] }] }));
      expect(state!.facts.map((f) => [f.statement, f.mentions]).sort()).toEqual([["One", 1], ["Two", 1]]);
    }));

  it("an answer that fits no schema fails the item: the facts are stored one by one", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "a.example" }), { statement: "One" });
      await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "b.example" }), { statement: "Two" });
      const { state } = await bundle(tx, placeId, () => ({ groups: "none" }));
      expect(state!.facts.map((f) => f.statement).sort()).toEqual(["One", "Two"]);
    }));

  it("a failed item keeps the earlier bundling that is still free; without one the facts go one by one", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const a = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "a.example" }), { statement: "One" });
      const b = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "b.example" }), { statement: "Two" });
      const first = await bundle(tx, placeId, (input) => ({ groups: [{ ids: input.facts.map((f) => f.id), representative: a, superseded: [] }] }));
      expect(first.state!.facts).toEqual([expect.objectContaining({ factId: a, mentions: 2 })]);
      const second = await bundle(tx, placeId, () => ({ groups: "none" }));
      expect(second.state!.facts).toEqual([expect.objectContaining({ factId: a, mentions: 2 })]);
      expect(second.state!.facts.map((f) => f.factId)).not.toContain(b);
    }));

  it("a berth with one fact is stored without a request; one without facts gets no row", () =>
    withRollback(async (tx) => {
      const one = (await insertPlace(tx)).placeId;
      const none = (await insertPlace(tx)).placeId;
      await seedStatement(tx, one, await seedPage(tx, config, one, {}), { statement: "Alone" });
      expect(await planBundleFacts(tx, [one, none], config)).toEqual([expect.objectContaining({ placeIds: [one] })]);
      const { result, state, batches } = await bundle(tx, one, () => ({ groups: [] }));
      expect(result.submitted).toBe(0);
      expect(batches).toHaveLength(0);
      expect(state!.facts.map((f) => f.statement)).toEqual(["Alone"]);
      expect(await tx.select().from(berthStates).where(eq(berthStates.placeId, none))).toHaveLength(0);
    }));

  it("drops a result of a prompt version that is no longer the active one", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "a.example" }), { statement: "One" });
      await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "b.example" }), { statement: "Two" });
      const changed: AppConfig = { ...config, models: { ...config.models, tasks: { ...config.models.tasks, "bundle-facts": { ...config.models.tasks["bundle-facts"]!, promptVersion: 2 } } } };
      const runId = await runWithStage(tx);
      const model = new MockModel({ "bundle-facts": () => ({ groups: [] }) });
      const [job] = await planBundleFacts(tx, [placeId], config);
      await bundleFactsJob(tx, { model, boss, config }, { runId, stage: STAGE, key: "bundle:0", placeIds: job!.placeIds as string[] }, QUEUE);
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      await pollBatch(tx, { model, boss, config: changed, handlers: { "bundle-facts": bundleFactsBatchEntry } }, batch!.id);
      expect(await tx.select().from(berthStates).where(eq(berthStates.placeId, placeId))).toHaveLength(0);
    }));

  it("does not send a berth that an unfinished batch already holds (another run)", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "a.example" }), { statement: "One" });
      await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "b.example" }), { statement: "Two" });
      const model = new MockModel({ "bundle-facts": () => ({ groups: [] }) });
      const [job] = await planBundleFacts(tx, [placeId], config);
      const send = async () =>
        bundleFactsJob(tx, { model, boss, config }, { runId: await runWithStage(tx), stage: STAGE, key: "bundle:0", placeIds: job!.placeIds as string[] }, QUEUE);
      expect((await send()).submitted).toBe(1);
      expect((await send()).submitted).toBe(0);
    }));
});
