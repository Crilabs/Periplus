import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places, reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { applyBerthVerdicts } from "@/lib/domain/research/confirmation";
import { gateDecisions, NOT_BERTH_REASON, syncConflictTasks } from "@/lib/domain/research/gate-conflicts";
import { placeOf } from "@/test/confirmation";
import { withRollback } from "@/test/db";
import { signalPage as signalPageIn } from "@/test/research-signals";

/* Conflicts with the reference as review tasks (plan N3 task 3) against real Postgres. */

const config: AppConfig = loadConfig("config");
const NOW = new Date("2026-10-23T12:00:00Z");
const signalPage = (tx: Db, place: { placeId: string; objectId: string }, o: Parameters<typeof signalPageIn>[3]) => signalPageIn(tx, config, place, o);

const tasksOf = (tx: Db, placeId: string) =>
  tx.select().from(reviewTasks).where(and(eq(reviewTasks.kind, "research_conflict"), eq(reviewTasks.subjectId, placeId)));

describe("syncConflictTasks", () => {
  it("opens one task per conflicting place and none twice", () =>
    withRollback(async (tx) => {
      const a = await placeOf(tx);
      const b = await placeOf(tx);
      expect(await syncConflictTasks(tx, [a.placeId, b.placeId], 2, [a.placeId, b.placeId])).toEqual({ created: 2, open: 2 });
      expect(await syncConflictTasks(tx, [a.placeId, b.placeId], 2, [a.placeId, b.placeId])).toEqual({ created: 0, open: 2 });
      const [task] = await tasksOf(tx, a.placeId);
      expect(task).toMatchObject({ subjectType: "research_conflict", status: "open", context: { threshold: 2 } });
      expect(await tasksOf(tx, a.placeId)).toHaveLength(1);
    }));

  it("closes the task of a place that is no conflict any more, with the reason", () =>
    withRollback(async (tx) => {
      const a = await placeOf(tx);
      const b = await placeOf(tx);
      await syncConflictTasks(tx, [a.placeId, b.placeId], 2, [a.placeId, b.placeId]);
      expect(await syncConflictTasks(tx, [a.placeId], 2, [a.placeId, b.placeId])).toEqual({ created: 0, open: 1 });
      expect((await tasksOf(tx, b.placeId))[0]).toMatchObject({ status: "dismissed", context: { dismissedReason: "no_longer_conflict" } });
      expect((await tasksOf(tx, a.placeId))[0]!.status).toBe("open");
    }));

  it("only touches the tasks of the given scope: another subdivision's open task survives", () =>
    withRollback(async (tx) => {
      const mine = await placeOf(tx);
      const other = await placeOf(tx);
      await syncConflictTasks(tx, [other.placeId], 2, [other.placeId]);
      expect(await syncConflictTasks(tx, [mine.placeId], 2, [mine.placeId])).toEqual({ created: 1, open: 1 });
      expect((await tasksOf(tx, other.placeId))[0]!.status).toBe("open");
      expect(await syncConflictTasks(tx, [], 2, [mine.placeId])).toEqual({ created: 0, open: 0 });
      expect((await tasksOf(tx, other.placeId))[0]!.status).toBe("open");
    }));

  it("does not ask again for a place a human decided", () =>
    withRollback(async (tx) => {
      const a = await placeOf(tx);
      await syncConflictTasks(tx, [a.placeId], 2, [a.placeId]);
      const [task] = await tasksOf(tx, a.placeId);
      await decideReviewTask(tx, { taskId: task!.id, decision: { action: "berth" }, decidedBy: "admin@test.invalid" });
      expect(await syncConflictTasks(tx, [a.placeId], 2, [a.placeId])).toEqual({ created: 0, open: 0 });
      expect(await tasksOf(tx, a.placeId)).toHaveLength(1);
    }));
});

describe("deciding a conflict", () => {
  it("„Kein Liegeplatz“ rejects the place with the reason; applyBerthVerdicts never confirms it again (Review Focus)", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      for (const d of ["a", "b", "c"]) await signalPage(tx, place, { domain: `${d}.example` });
      await syncConflictTasks(tx, [place.placeId], 2, [place.placeId]);
      const [task] = await tasksOf(tx, place.placeId);

      const result = await decideReviewTask(tx, { taskId: task!.id, decision: { action: "not_berth" }, decidedBy: "admin@test.invalid" });
      expect(result.consolidate).toEqual({ geoObjectId: place.objectId });
      const [row] = await tx.select().from(places).where(eq(places.id, place.placeId));
      expect(row).toMatchObject({ status: "rejected", statusReason: NOT_BERTH_REASON });
      expect(NOT_BERTH_REASON).toBe("Kein Liegeplatz laut Prüfung (Navily-Test)");
      expect((await tasksOf(tx, place.placeId))[0]!.status).toBe("decided");
      expect(await tx.select().from(reviewDecisions).where(eq(reviewDecisions.taskId, task!.id))).toHaveLength(1);

      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([]);
      expect((await tx.select().from(places).where(eq(places.id, place.placeId)))[0]!.status).toBe("rejected");
    }));

  it("„Liegeplatz“ keeps the status and stores the decision", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      await syncConflictTasks(tx, [place.placeId], 2, [place.placeId]);
      const [task] = await tasksOf(tx, place.placeId);
      const result = await decideReviewTask(tx, { taskId: task!.id, decision: { action: "berth" }, decidedBy: "admin@test.invalid" });
      expect(result.consolidate).toBeNull();
      expect((await tx.select().from(places).where(eq(places.id, place.placeId)))[0]).toMatchObject({ status: "candidate", statusReason: null });
    }));

  it("other actions do not fit the task", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      await syncConflictTasks(tx, [place.placeId], 2, [place.placeId]);
      const [task] = await tasksOf(tx, place.placeId);
      await expect(decideReviewTask(tx, { taskId: task!.id, decision: { action: "reject" }, decidedBy: "x" })).rejects.toThrow(/does not fit/);
    }));
});

describe("gateDecisions", () => {
  it("maps decided places to berth or not_berth whatever their status; undecided and open places are left out", () =>
    withRollback(async (tx) => {
      const yes = await placeOf(tx);
      const no = await placeOf(tx);
      const open = await placeOf(tx);
      const none = await placeOf(tx);
      await syncConflictTasks(tx, [yes.placeId, no.placeId, open.placeId], 2, [yes.placeId, no.placeId, open.placeId]);
      for (const [p, action] of [[yes, "berth"], [no, "not_berth"]] as const) {
        const [task] = await tasksOf(tx, p.placeId);
        await decideReviewTask(tx, { taskId: task!.id, decision: { action }, decidedBy: "admin@test.invalid" });
      }
      const map = await gateDecisions(tx, [yes.placeId, no.placeId, open.placeId, none.placeId]);
      expect([...map.entries()].sort()).toEqual([[yes.placeId, "berth"], [no.placeId, "not_berth"]].sort());
      expect((await tx.select().from(places).where(eq(places.id, no.placeId)))[0]!.status).toBe("rejected");
      expect(await gateDecisions(tx, [])).toEqual(new Map());
    }));
});
