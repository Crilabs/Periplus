import { and, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { facts, reviewTasks } from "@/lib/db/schema";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { valueFingerprint } from "@/lib/domain/review-decisions";
import { reviewTaskDetail } from "@/lib/domain/review-view";
import { insertComputation, insertPlace, insertSource, insertTextFact } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";

/*
 * The review of a profile attribute (conflict, uncertain change): the page data (`reviewTaskDetail`) and the decision
 * through the server action. Everything runs in withRollback on the synthetic grid around 21.0° E / 35.2° N: the
 * action's `getDb()` is the test's transaction (its own transactions become savepoints).
 */

let current: Db | undefined;
const requireAdmin = vi.fn();
const redirect = vi.fn();
vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => current ?? testDb(),
}));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({ insert: async () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import { decideAction } from "../review/[id]/actions";

const db = testDb();
let today = "";
beforeAll(async () => {
  const { rows } = await db.execute<{ today: string }>(sql`select current_date::text as today`);
  today = rows[0]!.today;
});

beforeEach(() => {
  vi.resetAllMocks();
  requireAdmin.mockResolvedValue({ email: "admin@example.invalid" });
  current = undefined;
});

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

/** A confirmed anchorage whose holding conflicts: good (trip report 0.6) against poor (trip report 0.5). */
async function conflictTask(tx: Db): Promise<{ objectId: string; taskId: string; key: string; goodFact: string; poorFact: string }> {
  const { objectId } = await insertPlace(tx, { name: "Profilbucht" });
  await insertComputation(tx, objectId, "shelter", { "shelter.N": 0.6 });
  const goodFact = await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.6), { attribute: "holding", value: "good", observedAt: "2026-07-01" });
  const poorFact = await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.5), { attribute: "holding", value: "poor", observedAt: "2026-07-02" });
  await consolidateGeo(tx, objectId, { today });
  const [task] = await tx
    .select({ id: reviewTasks.id, context: reviewTasks.context })
    .from(reviewTasks)
    .where(and(eq(reviewTasks.kind, "conflict"), eq(reviewTasks.subjectId, `${objectId}:holding`)));
  return { objectId, taskId: task!.id, key: (task!.context as { key: string }).key, goodFact, poorFact };
}

describe("review of a profile attribute", () => {
  it("shows the object, the attribute, the current value and both sides with their quoted facts", () =>
    withRollback(async (tx) => {
      const t = await conflictTask(tx);
      const detail = await reviewTaskDetail(tx, t.taskId);
      const s = detail!.subject;
      if (s.type !== "profile_attribute") throw new Error(`subject ${s.type}`);
      expect(s).toMatchObject({ geoObjectId: t.objectId, name: "Profilbucht", attribute: "holding", label: "Halt", key: t.key, resolution: null });
      expect(s.current).toMatchObject({ value: "good", display: "gut", provenance: { origin: "text" } });
      expect(s.a).toMatchObject({ value: "good", display: "gut", observedFrom: "2026-07-01", observedTo: "2026-07-01" });
      expect(s.b).toMatchObject({ value: "poor", display: "schlecht" });
      expect(s.a!.facts.map((f) => f.id)).toEqual([t.goodFact]);
      expect(s.b!.facts.map((f) => f.id)).toEqual([t.poorFact]);
      expect(s.a!.facts[0]).toMatchObject({ origin: "text", context: { quote: "good holding in sand" }, source: { weight: 0.6 } });
      expect(s.a!.weight).toBeGreaterThan(s.b!.weight);
      expect(s.proposed).toBeUndefined();
    }));

  it("the action decides with the shown key and redirects to the next task", () =>
    withRollback(async (tx) => {
      current = tx;
      const t = await conflictTask(tx);
      await decideAction(form({ taskId: t.taskId, taskKey: t.key, valueKey: valueFingerprint("poor"), decision: JSON.stringify({ action: "value_b" }) }));
      expect(redirect).toHaveBeenCalledTimes(1);
      expect(redirect.mock.calls[0]![0]).not.toContain(t.taskId);
      const [task] = await tx.select({ status: reviewTasks.status }).from(reviewTasks).where(eq(reviewTasks.id, t.taskId));
      expect(task!.status).toBe("decided");
      const reviewFacts = await tx.select().from(facts).where(and(eq(facts.geoObjectId, t.objectId), sql`${facts.reviewDecisionId} is not null`));
      expect(reviewFacts.map((f) => [f.attribute, f.value, f.confidence])).toEqual([["holding", "poor", 0.95]]);
    }));

  it("a decision on a value that changed since it was shown redirects back with the notice and writes nothing", () =>
    withRollback(async (tx) => {
      current = tx;
      const t = await conflictTask(tx);
      await decideAction(form({ taskId: t.taskId, taskKey: "0000000000000000", decision: JSON.stringify({ action: "value_a" }) }));
      expect(redirect).toHaveBeenCalledWith(`/review/${t.taskId}?changed=1`);
      const [task] = await tx.select({ status: reviewTasks.status }).from(reviewTasks).where(eq(reviewTasks.id, t.taskId));
      expect(task!.status).toBe("open");

      // a conflict action that does not fit an uncertain change is an error, not a decision
      await decideAction(form({ taskId: t.taskId, taskKey: t.key, decision: JSON.stringify({ action: "accept_change" }) }));
      expect(redirect).toHaveBeenLastCalledWith(`/review/${t.taskId}?error=1`);
    }));

  it("shows a text-scale value with its word on the card (shelter 0,9 = gut geschützt)", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx, { name: "Skalabucht" });
      await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.6), { attribute: "shelter.N", value: 0.9, observedAt: "2026-07-01" });
      const [task] = await tx
        .insert(reviewTasks)
        .values({ kind: "uncertain_change", subjectType: "profile_attribute", subjectId: `${objectId}:shelter.N`, context: { key: "k", newValue: 0.9 } })
        .returning({ id: reviewTasks.id });
      const s = (await reviewTaskDetail(tx, task!.id))!.subject;
      if (s.type !== "profile_attribute") throw new Error(`subject ${s.type}`);
      expect(s.proposed!.display).toBe("gut geschützt (0,9)");
    }));

  it("a run that swaps the sides between load and click makes the action redirect with the notice and write nothing", () =>
    withRollback(async (tx) => {
      current = tx;
      const t = await conflictTask(tx);
      const shown = (await reviewTaskDetail(tx, t.taskId))!.subject;
      if (shown.type !== "profile_attribute") throw new Error(`subject ${shown.type}`);
      expect(shown.a!.fingerprint).toBe(valueFingerprint("good"));

      await insertTextFact(tx, t.objectId, await insertSource(tx, "forum", 0.2), { attribute: "holding", value: "poor", observedAt: "2026-07-03" });
      await consolidateGeo(tx, t.objectId, { today });
      const now = (await reviewTaskDetail(tx, t.taskId))!.subject;
      if (now.type !== "profile_attribute") throw new Error(`subject ${now.type}`);
      expect([now.key, now.a!.value]).toEqual([t.key, "poor"]);

      await decideAction(form({ taskId: t.taskId, taskKey: t.key, valueKey: shown.a!.fingerprint, decision: JSON.stringify({ action: "value_a" }) }));
      expect(redirect).toHaveBeenCalledWith(`/review/${t.taskId}?changed=1`);
      const [task] = await tx.select({ status: reviewTasks.status }).from(reviewTasks).where(eq(reviewTasks.id, t.taskId));
      expect(task!.status).toBe("open");
      expect(await tx.select().from(facts).where(and(eq(facts.geoObjectId, t.objectId), sql`${facts.reviewDecisionId} is not null`))).toEqual([]);
    }));

  it("a decided conflict shows its resolution from the current profile", () =>
    withRollback(async (tx) => {
      current = tx;
      const t = await conflictTask(tx);
      await decideAction(form({ taskId: t.taskId, taskKey: t.key, decision: JSON.stringify({ action: "seasonal" }) }));
      await consolidateGeo(tx, t.objectId, { today });
      const s = (await reviewTaskDetail(tx, t.taskId))!.subject;
      if (s.type !== "profile_attribute") throw new Error(`subject ${s.type}`);
      expect(s.resolution).toBe("seasonal");
    }));
});
