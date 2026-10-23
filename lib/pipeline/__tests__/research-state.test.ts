import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { getConfig, getConsolidationConfig, loadConfig, type AppConfig } from "@/lib/config";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { berthStates, places, runs, wikidataSitelinks } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { createRun } from "@/lib/domain/runs";
import { MockModel } from "@/lib/ai/mock";
import { setModelClientFactory } from "@/lib/jobs/handlers/ai-batch";
import { HANDLERS } from "@/lib/jobs/registry";
import { STAGES } from "@/lib/jobs/stages";
import type { JobContext } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import { BERTH_FOLLOWUP_STAGES, startBerthFollowupRun } from "@/lib/pipeline/berth-followup-run";
import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";
import { buildBerthState, planResearchState, RESEARCH_STATE_STAGE, statePlaces } from "@/lib/pipeline/research/state";
import { RESEARCH_STAGES } from "@/lib/pipeline/research-run";
import { storeStateFacts } from "@/lib/domain/research/state-facts";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { seedPage, seedStatement } from "@/test/research-state";
import { insertTestGeoObject } from "@/test/text";
import type { Db } from "@/lib/db/client";

const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };
const rules = getConsolidationConfig(getConfig().consolidation.version);
const LON = 21.0;
const LAT = 35.2;

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
const ctxFor = (db: Db, boss: PgBoss): JobContext => ({ db, boss, log: createLogger("test"), jobId: newId() });

async function marina(tx: Db, status: "confirmed" | "candidate" = "confirmed") {
  const p = await insertPlace(tx, { type: "harbour", status });
  await tx.update(places).set({ kind: "marina" }).where(eq(places.id, p.placeId));
  return p;
}

describe("research.state stage", () => {
  it("is the eighth stage of the research run, after the confirmation, and the follow-up builds it before the image", () => {
    expect(RESEARCH_STAGES).toHaveLength(8);
    expect(RESEARCH_STAGES[7]).toBe(RESEARCH_STATE_STAGE);
    expect(RESEARCH_STAGES[6]).toBe("research.confirm");
    expect([...BERTH_FOLLOWUP_STAGES]).toEqual([RESEARCH_STATE_STAGE, IMAGES_STAGE]);
    expect(STAGES[RESEARCH_STATE_STAGE]?.queue).toBe("research.state");
    expect(HANDLERS["research.state"]).toBeTypeOf("function");
    expect(getConfig().queues["research.state"]).toBeDefined();
  });

  it("plans a build job per confirmed berth of the run and none for a candidate", () =>
    withRollback(async (tx) => {
      const a = await marina(tx);
      const b = await marina(tx, "candidate");
      const params = { placeIds: [a.placeId, b.placeId] };
      expect(await statePlaces(tx, params)).toEqual([a.placeId]);
      expect(await planResearchState(tx, { id: newId(), params }, config)).toEqual([{ key: `state:${a.placeId}`, placeId: a.placeId }]);
    }));

  it("also plans a bundling job when the berth has free facts", () =>
    withRollback(async (tx) => {
      const a = await marina(tx);
      await seedStatement(tx, a.placeId, await seedPage(tx, config, a.placeId), { statement: "Taverna by the quay" });
      const jobs = await planResearchState(tx, { id: newId(), params: { placeIds: [a.placeId] } }, config);
      expect(jobs).toEqual([{ key: `state:${a.placeId}`, placeId: a.placeId }, { key: "bundle:0", placeIds: [a.placeId] }]);
    }));

  it("builds core values, landing and reachable without touching the bundled facts", () =>
    withRollback(async (tx) => {
      const a = await marina(tx);
      // a bus stop 300 m north of the harbour: reachable on foot
      await insertTestGeoObject(tx, { type: "poi", category: "transport", tags: {}, geom: geomFromGeoJson({ type: "Point", coordinates: [LON, LAT + 300 / 111_195] }) });
      const fact = await seedStatement(tx, a.placeId, await seedPage(tx, config, a.placeId), { statement: "Good taverna", subjectName: "Taverna Nikos", subjectCategory: "food" });
      await storeStateFacts(tx, a.placeId, [
        { factId: fact, subject: "landside", subjectName: "Taverna Nikos", subjectCategory: "food", statement: "Good taverna", observedAt: "2025-06-15", tone: null, safety: false, mentions: 1 },
      ]);
      const runId = (await createRun(tx, { kind: "stage", scope: { type: "system", id: `s-${newId()}` }, stages: [RESEARCH_STATE_STAGE], triggeredBy: "test" })).id;

      expect(await buildBerthState(tx, a.placeId, { runId, rules, config, today: "2026-10-23" })).toEqual({ built: true });
      const [row] = await tx.select().from(berthStates).where(eq(berthStates.placeId, a.placeId));
      expect(row!.core.berthable).toMatchObject({ value: true, origin: "rule" });
      expect(row!.landing[0]).toMatchObject({ kind: "harbour", geoObjectId: a.objectId });
      expect(row!.nearby.map((n) => [n.category, n.access])).toEqual([["transport", "foot"]]);
      expect(row!.runId).toBe(runId);
      expect(row!.facts.map((f) => f.factId)).toEqual([fact]);

      // a second build keeps the facts as well
      await buildBerthState(tx, a.placeId, { runId, rules, config, today: "2026-10-24" });
      const [again] = await tx.select().from(berthStates).where(eq(berthStates.placeId, a.placeId));
      expect(again!.facts.map((f) => f.factId)).toEqual([fact]);
    }));

  it("skips a berth that is no longer confirmed: its row stays unchanged", () =>
    withRollback(async (tx) => {
      const a = await marina(tx);
      const runId = (await createRun(tx, { kind: "stage", scope: { type: "system", id: `s-${newId()}` }, stages: [RESEARCH_STATE_STAGE], triggeredBy: "test" })).id;
      await buildBerthState(tx, a.placeId, { runId, rules, config, today: "2026-10-23" });
      const [before] = await tx.select().from(berthStates).where(eq(berthStates.placeId, a.placeId));

      await tx.update(places).set({ status: "candidate" }).where(eq(places.id, a.placeId));
      expect(await buildBerthState(tx, a.placeId, { runId, rules, config, today: "2030-01-01" })).toEqual({ built: false });
      const [after] = await tx.select().from(berthStates).where(eq(berthStates.placeId, a.placeId));
      expect(after).toEqual(before);
      expect(await statePlaces(tx, { placeIds: [a.placeId] })).toEqual([]);
    }));

  it("the build job reads the rules version frozen in the run params", () =>
    withRollback(async (tx) => {
      const a = await marina(tx);
      const rulesVersion = getConsolidationConfig(getConfig().consolidation.version).version;
      const runId = (
        await createRun(tx, { kind: "stage", scope: { type: "system", id: `s-${newId()}` }, stages: [RESEARCH_STATE_STAGE], params: { placeIds: [a.placeId], rulesVersion }, triggeredBy: "test" })
      ).id;
      const { boss } = recordingBoss();
      await HANDLERS["research.state"]({ runId, stage: RESEARCH_STATE_STAGE, key: `state:${a.placeId}`, placeId: a.placeId }, ctxFor(tx, boss));
      expect(await tx.select().from(berthStates).where(eq(berthStates.placeId, a.placeId))).toHaveLength(1);

      // a corrupted frozen version fails loudly instead of falling back
      await tx.update(runs).set({ params: { placeIds: [a.placeId], rulesVersion: 7 } }).where(eq(runs.id, runId));
      await expect(HANDLERS["research.state"]({ runId, stage: RESEARCH_STATE_STAGE, key: `state:${a.placeId}`, placeId: a.placeId }, ctxFor(tx, boss))).rejects.toThrow();
    }));

  it("the follow-up run freezes the rules version and builds the state first, then the image stage follows", () =>
    withRollback(async (tx) => {
      const a = await marina(tx);
      const { boss, inserted } = recordingBoss();
      const started = await startBerthFollowupRun(tx, boss, [a.placeId], "test");
      const [run] = await tx.select().from(runs).where(eq(runs.id, started!.id));
      expect(run!.params).toMatchObject({ placeIds: [a.placeId], rulesVersion: getConsolidationConfig(getConfig().consolidation.version).version });
      expect(inserted.map((j) => [j.queue, j.data.placeId])).toEqual([["research.state", a.placeId]]);
      await HANDLERS["research.state"](inserted[0]!.data as never, ctxFor(tx, boss));
      expect(await tx.select().from(berthStates).where(eq(berthStates.placeId, a.placeId))).toHaveLength(1);
    }));
  it("the bundling job (placeIds) of the handler stores a berth with one fact without a request; a job without places fails", () =>
    withRollback(async (tx) => {
      const a = await marina(tx);
      const fact = await seedStatement(tx, a.placeId, await seedPage(tx, config, a.placeId), { statement: "Taverna by the quay" });
      const runId = (await createRun(tx, { kind: "stage", scope: { type: "system", id: `s-${newId()}` }, stages: [RESEARCH_STATE_STAGE], triggeredBy: "test" })).id;
      const { boss } = recordingBoss();
      setModelClientFactory(() => new MockModel({}));
      try {
        await HANDLERS["research.state"]({ runId, stage: RESEARCH_STATE_STAGE, key: "bundle:0", placeIds: [a.placeId] }, ctxFor(tx, boss));
        const [row] = await tx.select().from(berthStates).where(eq(berthStates.placeId, a.placeId));
        expect(row!.facts.map((f) => [f.factId, f.mentions])).toEqual([[fact, 1]]);
        // the bundling branch never builds core values
        expect(row!.core).toEqual({});
        await expect(HANDLERS["research.state"]({ runId, stage: RESEARCH_STATE_STAGE, key: "bundle:1", placeIds: [] }, ctxFor(tx, boss))).rejects.toThrow();
      } finally {
        setModelClientFactory(undefined);
      }
    }));

  it("storing facts skips a berth that is no longer confirmed: no row is created, an existing one stays", () =>
    withRollback(async (tx) => {
      const gone = await marina(tx, "candidate");
      const fact = await seedStatement(tx, gone.placeId, await seedPage(tx, config, gone.placeId), { statement: "Taverna by the quay" });
      const stored = { factId: fact, subject: "berth" as const, subjectName: null, subjectCategory: null, statement: "Taverna by the quay", observedAt: "2025-06-15", tone: null, safety: false, mentions: 1 };
      await storeStateFacts(tx, gone.placeId, [stored]);
      expect(await tx.select().from(berthStates).where(eq(berthStates.placeId, gone.placeId))).toHaveLength(0);

      const was = await marina(tx);
      await storeStateFacts(tx, was.placeId, [stored]);
      await tx.update(places).set({ status: "candidate" }).where(eq(places.id, was.placeId));
      await storeStateFacts(tx, was.placeId, []);
      const [row] = await tx.select().from(berthStates).where(eq(berthStates.placeId, was.placeId));
      expect(row!.facts.map((f) => f.factId)).toEqual([fact]);
    }));

  it("a newer negative transport fact closes bus and taxi access (bus discontinued 2025 after the bus of 2019)", () =>
    withRollback(async (tx) => {
      const a = await marina(tx);
      const wikidataId = `Q${Math.floor(Math.random() * 1e12)}`;
      const monastery = await insertTestGeoObject(tx, { type: "poi", category: "culture", tags: {}, wikidataId, geom: geomFromGeoJson({ type: "Point", coordinates: [LON, LAT + 5000 / 111_195] }) });
      await tx.insert(wikidataSitelinks).values({ wikidataId, sitelinks: 9, fetchedAt: new Date() });
      const page = await seedPage(tx, config, a.placeId);
      await seedStatement(tx, a.placeId, page, { statement: "A bus runs to town", subjectName: "Bus", subjectCategory: "bus", observedAt: "2019-06-01", tone: "positive" });
      const runId = (await createRun(tx, { kind: "stage", scope: { type: "system", id: `s-${newId()}` }, stages: [RESEARCH_STATE_STAGE], triggeredBy: "test" })).id;
      const access = async () => (await tx.select().from(berthStates).where(eq(berthStates.placeId, a.placeId)))[0]!.nearby.find((n) => n.geoObjectId === monastery)?.access;

      await buildBerthState(tx, a.placeId, { runId, rules, config, today: "2026-10-23" });
      expect(await access()).toBe("transport");
      await seedStatement(tx, a.placeId, page, { statement: "The bus was discontinued", subjectName: "Bus", subjectCategory: "bus", observedAt: "2025-06-01", tone: "negative" });
      await buildBerthState(tx, a.placeId, { runId, rules, config, today: "2026-10-23" });
      expect(await access()).toBeUndefined();
    }));
});
