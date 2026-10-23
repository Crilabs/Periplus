import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { MockModel } from "@/lib/ai/mock";
import type { BundleFactsInput } from "@/lib/ai/tasks/bundle-facts";
import { getConfig, getConsolidationConfig, loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { aiBatches, berthStates, places, sources } from "@/lib/db/schema";
import { addNames } from "@/lib/domain/gazetteer/names";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun } from "@/lib/domain/runs";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { pollBatch } from "@/lib/pipeline/batches";
import { standingFacts, storeStateFacts } from "@/lib/domain/research/state-facts";
import { buildBerthState, bundleFactsBatchEntry, bundleFactsJob, planBundleFacts } from "@/lib/pipeline/research/state";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { seedPage, seedStatement } from "@/test/research-state";
import { insertTestGeoObject } from "@/test/text";

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

  it("a failed item after an earlier bundling adds the facts that came since as single ones, a new safety fact included", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const a = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "a.example" }), { statement: "One" });
      const b = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "b.example" }), { statement: "Two" });
      await bundle(tx, placeId, (input) => ({ groups: [{ ids: input.facts.map((f) => f.id), representative: a, superseded: [] }] }));
      const rock = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "c.example" }), { statement: "Rock at the entrance", tone: "negative", safety: true });
      const { state } = await bundle(tx, placeId, () => ({ groups: "none" }));
      expect(state!.facts.map((f) => [f.factId, f.mentions, f.safety])).toEqual([[a, 2, false], [rock, 1, true]]);
      expect(state!.facts.map((f) => f.factId)).not.toContain(b);
    }));

  it("the stored facts carry their group's member ids, a single fact its own id", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const a = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "a.example" }), { statement: "One", observedAt: "2024-06-01" });
      const b = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "b.example" }), { statement: "Two", observedAt: "2025-06-01" });
      const c = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "c.example" }), { statement: "Three" });
      const { state } = await bundle(tx, placeId, () => ({ groups: [{ ids: [a, b], representative: b, superseded: [a] }] }));
      expect(state!.facts.map((f) => [f.factId, [...(f.memberIds ?? [])].sort()])).toEqual([[b, [a, b].sort()], [c, [c]]]);
    }));

  it("a representative whose source ended and a failed next bundling: a still-free safety member comes back as a single", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const repPage = await seedPage(tx, config, placeId, { domain: "a.example" });
      const rep = await seedStatement(tx, placeId, repPage, { statement: "Rocky entrance, keep north" });
      const rock = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "b.example" }), { statement: "Rock at the entrance", safety: true });
      const first = await bundle(tx, placeId, () => ({ groups: [{ ids: [rep, rock], representative: rep, superseded: [] }] }));
      expect(first.state!.facts.map((f) => f.factId)).toEqual([rep]);
      await tx.update(sources).set({ validTo: "2026-10-01" }).where(eq(sources.id, repPage.sourceId));
      // a new fact since, so the next bundling sends a request (two free facts) that fails
      const later = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "c.example" }), { statement: "Taverna open", observedAt: "2026-06-01" });
      const { state, batches } = await bundle(tx, placeId, () => ({ groups: "none" }));
      expect(batches.length).toBeGreaterThan(0);
      expect(state!.facts.map((f) => [f.factId, f.safety, f.mentions])).toEqual([[rock, true, 1], [later, false, 1]]);
    }));

  it("an old stored row without member ids never loses a free fact", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const a = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "a.example" }), { statement: "One" });
      const b = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "b.example" }), { statement: "Two" });
      const first = await bundle(tx, placeId, () => ({ groups: [{ ids: [a, b], representative: a, superseded: [] }] }));
      // a row written before member ids existed
      await storeStateFacts(tx, placeId, first.state!.facts.map((f) => ({ ...f, memberIds: undefined })));
      const { state } = await bundle(tx, placeId, () => ({ groups: "none" }));
      expect(state!.facts.map((f) => f.factId)).toEqual([a, b]);
    }));

  it("the standing facts do not depend on the active bundler: after a prompt change a group member stays hidden", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const a = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "a.example" }), { statement: "One" });
      const b = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "b.example" }), { statement: "Two" });
      await bundle(tx, placeId, () => ({ groups: [{ ids: [a, b], representative: a, superseded: [] }] }));
      const changed: AppConfig = { ...config, models: { ...config.models, tasks: { ...config.models.tasks, "bundle-facts": { ...config.models.tasks["bundle-facts"]!, promptVersion: 2 } } } };
      expect((await standingFacts(tx, placeId, changed)).map((f) => [f.factId, f.mentions])).toEqual([[a, 2]]);
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
  it("the state build reads the bundled facts: a POI named only by a superseded fact is not listed", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx, { type: "harbour" });
      await tx.update(places).set({ kind: "marina" }).where(eq(places.id, placeId));
      const kayak = await insertTestGeoObject(tx, { type: "poi", category: "active", tags: {}, geom: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2 + 300 / 111_195] }) });
      await addNames(tx, kayak, [{ name: "Kayak Nikos", language: "en", origin: "osm" }]);
      const old = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "a.example" }), {
        statement: "Kayaks to hire", subjectName: "Kayak Nikos", subjectCategory: "rental", observedAt: "2019-06-01", tone: "positive",
      });
      const now = await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { domain: "b.example" }), {
        statement: "Boat hire closed", subjectName: "Old boat hire", subjectCategory: "rental", observedAt: "2025-06-01", tone: "negative",
      });
      const rules = getConsolidationConfig(getConfig().consolidation.version);
      const nearbyAfterBuild = async () => {
        await buildBerthState(tx, placeId, { runId: null, rules, config, today: "2026-10-23" });
        return (await tx.select().from(berthStates).where(eq(berthStates.placeId, placeId)))[0]!.nearby.map((n) => n.geoObjectId);
      };
      // not bundled yet: every free fact counts
      expect(await nearbyAfterBuild()).toContain(kayak);
      // bundled: the older fact is superseded by the newer one and names nothing any more
      await bundle(tx, placeId, () => ({ groups: [{ ids: [old, now], representative: now, superseded: [old] }] }));
      expect(await nearbyAfterBuild()).not.toContain(kayak);
    }));
});
