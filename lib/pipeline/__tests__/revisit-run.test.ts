import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSimulationMode } from "@/lib/adapters/simulation";
import { documents, documentVersions, externalCalls, runs } from "@/lib/db/schema";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { spotAsOf } from "@/lib/domain/delivery/read";
import { parseScenario, type RevisitScenario } from "@/lib/domain/revisit/scenario";
import { verifyRevisit } from "@/lib/domain/revisit/verify";
import { REVISIT_STAGES } from "@/lib/pipeline/revisit-run";
import { withRollback } from "@/test/db";
import { maxSeq, recordedState, revisit } from "@/test/revisit/fixture/run";

/*
 * The simulated revisit end to end on the one-tile fixture area (plan Task 14, spec 10 CI criterion), inside
 * withRollback: „Lauf 1“ (a text run over the recorded versions, 2026-05-01) and the package of that state, then two
 * revisit runs (2026-06-01 and 2026-06-08) started by `startRevisitRun` and driven job by job like the worker would —
 * the simulated crawl (`fetch.source`, `fetch.url` with the scenario's fetcher, `embed.chunks` with fake embeddings),
 * `revisit.freeze`, every text stage with the fake model, the consolidation. Nothing reaches the network: the crawl's
 * only transport is the in-process simulated one, the model is a MockModel, the embeddings come from a fake Voyage
 * transport, and the test checks that no blocked service was called. The harness is `test/revisit/fixture/run.ts`.
 */

const scenario: RevisitScenario = parseScenario(
  readFileSync(join(process.cwd(), "test/revisit/fixture/scenario.json"), "utf8"),
  "test/revisit/fixture/scenario.json",
);

const TIMEOUT = 120_000;

beforeEach(() => setSimulationMode(undefined));
afterEach(() => setSimulationMode(undefined));

describe("simulated revisit on the fixture area", () => {
  it(
    "the simulated revisit shows exactly the scenario's changes and the old spot stays readable",
    () =>
      withRollback(async (tx) => {
        const { archive, fx, fromSeq } = await recordedState(tx);
        // the call rows that exist before the revisits (visible to this transaction): the rest is the test window's
        const callsBefore = new Set((await tx.select({ id: externalCalls.id }).from(externalCalls)).map((c) => c.id));
        setSimulationMode(true);
        const revisits: Array<Awaited<ReturnType<typeof revisit>>> = [];
        for (const day of ["2026-06-01", "2026-06-08"]) revisits.push(await revisit(tx, archive, day, scenario));
        setSimulationMode(undefined);

        const v = await verifyRevisit(tx, scenario, { fromSeq, areaKey: fx.areaKey });
        expect(v.unexpected).toEqual([]);
        expect(v.entries.map((e) => [e.id, e.ok])).toEqual([
          ["e1", true],
          ["e2", true],
          ["e3", true],
          ["e4", true],
          ["e5", true],
        ]);
        expect(v.correct).toBe(5);
        expect(v.passes).toBe(true);

        // the gone page turned gone at its second miss, and its object was judged again (ruling M7-P7)
        const [d3] = await tx.select().from(documents).where(eq(documents.id, fx.documents.d3.id));
        expect(d3).toMatchObject({ status: "gone", consecutiveGone: 2 });
        const [second] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, revisits[1]!.id));
        expect((second!.params as { goneGeoObjectIds: string[] }).goneGeoObjectIds).toEqual([fx.places.A.geoObjectId]);

        // the runs: kind revisit, no follow-up stage, no geocoding or follow-up job (ruling M7-P8)
        for (const r of revisits) {
          const [row] = await tx.select().from(runs).where(eq(runs.id, r.id));
          expect(row).toMatchObject({ kind: "revisit", scopeType: "area", scopeId: fx.areaKey, status: "finished" });
          expect(row!.stages).toEqual(REVISIT_STAGES.filter((s) => s !== "consolidation.followup"));
          expect(r.queues.filter((q) => ["mentions.geocode", "consolidation.followup", "discovery.place", "discovery.tile"].includes(q))).toEqual([]);
        }
        // nothing reached a blocked service (ruling M7-P8): every call row written during the revisits — with or
        // without a run id — is the simulated robots.txt (answered in process), a fake embedding or a MockModel batch,
        // the two services a simulation may use, and nothing cost anything
        const calls = (await tx.select().from(externalCalls)).filter((c) => !callsBefore.has(c.id));
        expect(calls.length).toBeGreaterThan(0);
        expect([...new Set(calls.filter((c) => !["robots", "voyage", "anthropic"].includes(c.service)).map((c) => c.service))]).toEqual([]);
        expect([...new Set(calls.filter((c) => c.service === "robots").map((c) => c.operation))]).toEqual(["robots.txt"]);
        expect(calls.reduce((sum, c) => sum + Number(c.costEur), 0)).toBe(0);
        // the simulated versions carry the first revisit run
        const simulated = await tx.select({ runId: documentVersions.runId }).from(documentVersions).where(eq(documentVersions.simulated, true));
        expect(new Set(simulated.filter((s) => s.runId !== null && revisits.some((r) => r.id === s.runId)).map((s) => s.runId))).toEqual(new Set([revisits[0]!.id]));

        const after = await buildDelivery(tx, archive, fx.areaId, { now: new Date("2026-06-08T08:00:00Z"), inCallerTransaction: true });
        expect(after).toMatchObject({ status: "valid", dataVersion: 2 });
        // the old version is the old value: the taverna open before the revisit, closed after it
        const old = (await spotAsOf(tx, archive, fx.publicIds.A, "2026-05-15"))!;
        const now = (await spotAsOf(tx, archive, fx.publicIds.A, "2026-06-09"))!;
        expect([old.dataVersion, now.dataVersion]).toEqual([1, 2]);
        expect([old.spot.services?.taverna, now.spot.services?.taverna]).toEqual(["yes", "no"]);
      }),
    TIMEOUT,
  );

  it(
    "a second revisit without further changes adds no change event",
    () =>
      withRollback(async (tx) => {
        const { archive, fx } = await recordedState(tx);
        setSimulationMode(true);
        for (const day of ["2026-06-01", "2026-06-08"]) await revisit(tx, archive, day, scenario);
        const before = await maxSeq(tx);
        const seen = { extract: [] as string[] };
        await revisit(tx, archive, "2026-06-15", scenario, seen);
        setSimulationMode(undefined);
        // nothing new to extract, and not one event for an object of the area
        expect(seen.extract).toEqual([]);
        const objects = [fx.areaId, fx.islandId, ...Object.values(fx.places).map((p) => p.geoObjectId)];
        const { rows } = await tx.execute(sql`
          select seq from change_events
          where seq > ${before} and geo_object_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(objects)}::jsonb))`);
        expect(rows).toEqual([]);
      }),
    TIMEOUT,
  );

  it(
    "a scenario expecting a wrong type fails verification with one missing and one unexpected",
    () =>
      withRollback(async (tx) => {
        const { archive, fx, fromSeq } = await recordedState(tx);
        setSimulationMode(true);
        for (const day of ["2026-06-01", "2026-06-08"]) await revisit(tx, archive, day, scenario);
        setSimulationMode(undefined);
        // e2 expects the depth change as uncertain: the scenario is wrong, the pipeline right
        const wrong: RevisitScenario = {
          ...scenario,
          entries: scenario.entries.map((e) => (e.id === "e2" ? { ...e, expect: { ...e.expect, events: [{ ...e.expect.events[0]!, type: "uncertain" as const }] } } : e)),
        };
        const v = await verifyRevisit(tx, wrong, { fromSeq, areaKey: fx.areaKey });
        expect(v.entries.find((e) => e.id === "e2")).toMatchObject({ events: { expected: 1, matched: 0 }, ok: false });
        expect(v.correct).toBe(4);
        expect(v.unexpected.map((u) => [u.subject, u.attribute, u.type, u.severity])).toEqual([[fx.publicIds.B, "depth.min", "changed", "safety"]]);
        expect(v.passes).toBe(false);
      }),
    TIMEOUT,
  );
});
