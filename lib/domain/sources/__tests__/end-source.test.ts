import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { changeEvents, geoObjects, reviewTasks, sources } from "@/lib/db/schema";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { endSource, getSource, resumeSource } from "@/lib/domain/sources/store";
import { latestProfile } from "@/lib/domain/timeline";
import { insertPlace, insertSource, insertTextFact } from "@/test/consolidation";
import { withRollback } from "@/test/db";

/*
 * „Quelle beenden“ (ruling M6-H-R1), the remedy of a package blocked by `foreign_content`: the source ends, its facts
 * stop counting, and the objects to consolidate again are named. withRollback on the synthetic grid around 21.0/35.2.
 */

async function utcToday(tx: Db): Promise<string> {
  const { rows } = await tx.execute<{ d: string }>(sql`select (now() at time zone 'UTC')::date::text as d`);
  return rows[0]!.d;
}

async function approvedSource(tx: Db): Promise<string> {
  const id = await insertSource(tx, "forum", 0.4);
  await tx.update(sources).set({ status: "approved" }).where(eq(sources.id, id));
  return id;
}

describe("endSource", () => {
  it("ends an approved source today and names its objects, a merged one by its final target", () =>
    withRollback(async (tx) => {
      const sourceId = await approvedSource(tx);
      const a = await insertPlace(tx, { name: "Endbucht" });
      const dropped = await insertPlace(tx, { name: "Alte Bucht", lon: 21.01 });
      const keep = await insertPlace(tx, { name: "Neue Bucht", lon: 21.02 });
      const untouched = await insertPlace(tx, { name: "Andere Bucht", lon: 21.03 });
      await insertTextFact(tx, a.objectId, sourceId, { attribute: "holding", value: "good", observedAt: "2026-07-01" });
      await insertTextFact(tx, dropped.objectId, sourceId, { attribute: "holding", value: "poor", observedAt: "2026-07-01" });
      await insertTextFact(tx, untouched.objectId, await approvedSource(tx), { attribute: "holding", value: "good", observedAt: "2026-07-01" });
      await tx.update(geoObjects).set({ mergedIntoId: keep.objectId }).where(eq(geoObjects.id, dropped.objectId));

      const result = await endSource(tx, sourceId);
      expect(result).toEqual({ ended: true, geoObjectIds: [a.objectId, keep.objectId].sort() });
      const source = await getSource(tx, sourceId);
      expect(source).toMatchObject({ status: "approved", validTo: await utcToday(tx) });
      // ended for good: neither ended again nor resumed
      expect(await endSource(tx, sourceId)).toEqual({ ended: false, geoObjectIds: [] });
      expect(await resumeSource(tx, sourceId)).toBe(false);
    }));

  it("a paused source ends too; a proposed or rejected one does not", () =>
    withRollback(async (tx) => {
      const paused = await approvedSource(tx);
      await tx.update(sources).set({ status: "paused" }).where(eq(sources.id, paused));
      expect((await endSource(tx, paused)).ended).toBe(true);
      for (const status of ["proposed", "rejected"] as const) {
        const id = await insertSource(tx);
        await tx.update(sources).set({ status }).where(eq(sources.id, id));
        expect(await endSource(tx, id)).toEqual({ ended: false, geoObjectIds: [] });
        expect((await getSource(tx, id))!.validTo).toBeNull();
      }
    }));

  it("the next consolidation leaves the ended source's values out", () =>
    withRollback(async (tx) => {
      const sourceId = await approvedSource(tx);
      const { objectId } = await insertPlace(tx, { name: "Navilybucht" });
      await insertTextFact(tx, objectId, sourceId, { attribute: "holding", value: "good", observedAt: "2026-07-01" });
      const today = await utcToday(tx);
      await consolidateGeo(tx, objectId, { today });
      expect((await latestProfile(tx, objectId))!.attributes["holding"]).toBe("good");
      await endSource(tx, sourceId);
      await consolidateGeo(tx, objectId, { today });
      expect((await latestProfile(tx, objectId))!.attributes["holding"]).toBeUndefined();
    }));

  it("one weak post after the end does not raise a shelter sector: null and one uncertain_change task until decided (ruling M6-FIN-R2)", () =>
    withRollback(async (tx) => {
      const navily = await insertSource(tx, "travel_guide", 0.9);
      await tx.update(sources).set({ status: "approved" }).where(eq(sources.id, navily));
      const forum = await approvedSource(tx);
      const { objectId } = await insertPlace(tx, { name: "Schutzbucht" });
      await insertTextFact(tx, objectId, navily, { attribute: "shelter.S", value: 0.4, observedAt: "2026-07-01", confidence: 0.9 });
      const today = await utcToday(tx);
      await consolidateGeo(tx, objectId, { today });
      expect((await latestProfile(tx, objectId))!.attributes["shelter.S"]).toBe(0.4);

      await endSource(tx, navily);
      await insertTextFact(tx, objectId, forum, { attribute: "shelter.S", value: 0.9, observedAt: "2026-08-01" });
      const tasks = () =>
        tx.select().from(reviewTasks).where(and(eq(reviewTasks.kind, "uncertain_change"), eq(reviewTasks.subjectId, `${objectId}:shelter.S`)));

      await consolidateGeo(tx, objectId, { today });
      expect((await latestProfile(tx, objectId))!.attributes["shelter.S"]).toBeUndefined();
      const [task, ...more] = await tasks();
      expect(more).toEqual([]);
      expect(task).toMatchObject({ status: "open", priority: 2, context: expect.objectContaining({ oldValue: null, newValue: 0.9 }) });

      // a second run while the task is open: still null, the same single task
      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "unchanged", events: 0, tasks: 0 });
      expect((await latestProfile(tx, objectId))!.attributes["shelter.S"]).toBeUndefined();
      expect(await tasks()).toEqual([expect.objectContaining({ id: task!.id, status: "open" })]);

      // deciding the task applies the value
      const taskKey = (task!.context as { key: string }).key;
      await decideReviewTask(tx, { taskId: task!.id, decision: { action: "accept_change" }, decidedBy: "admin@example.invalid", taskKey });
      await consolidateGeo(tx, objectId, { today });
      expect((await latestProfile(tx, objectId))!.attributes["shelter.S"]).toBe(0.9);
    }));
  it("after a discard, a second weak post stays null and opens a new task; a strong source ends the hold (ruling M6-FIN-R3)", () =>
    withRollback(async (tx) => {
      const navily = await insertSource(tx, "travel_guide", 0.9);
      await tx.update(sources).set({ status: "approved" }).where(eq(sources.id, navily));
      const forum = await approvedSource(tx);
      const { objectId } = await insertPlace(tx, { name: "Haltebucht" });
      await insertTextFact(tx, objectId, navily, { attribute: "shelter.S", value: 0.4, observedAt: "2026-07-01", confidence: 0.9 });
      const today = await utcToday(tx);
      await consolidateGeo(tx, objectId, { today });
      await endSource(tx, navily);
      await insertTextFact(tx, objectId, forum, { attribute: "shelter.S", value: 0.9, observedAt: "2026-08-01" });
      await consolidateGeo(tx, objectId, { today });
      const tasks = () =>
        tx.select().from(reviewTasks).where(and(eq(reviewTasks.kind, "uncertain_change"), eq(reviewTasks.subjectId, `${objectId}:shelter.S`)));
      const [first] = await tasks();
      await decideReviewTask(tx, { taskId: first!.id, decision: { action: "discard_change" }, decidedBy: "admin@example.invalid", taskKey: (first!.context as { key: string }).key });

      // the same post after the discard: still null, no task
      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "unchanged", events: 0, tasks: 0 });
      const held = await latestProfile(tx, objectId);
      expect(held!.attributes["shelter.S"]).toBeUndefined();

      // a second post of the same forum (a new key): still null, a new open task with its uncertain event on the same version
      await insertTextFact(tx, objectId, forum, { attribute: "shelter.S", value: 0.9, observedAt: "2026-09-01" });
      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "unchanged", version: held!.version, events: 1, tasks: 1 });
      expect((await latestProfile(tx, objectId))!.attributes["shelter.S"]).toBeUndefined();
      const open = (await tasks()).filter((t) => t.status === "open");
      expect(open).toEqual([expect.objectContaining({ priority: 2, context: expect.objectContaining({ oldValue: null, newValue: 0.9 }) })]);
      const events = await tx.select().from(changeEvents).where(and(eq(changeEvents.geoObjectId, objectId), eq(changeEvents.type, "uncertain")));
      expect(events.filter((e) => (e.details as { taskId?: string }).taskId === open[0]!.id)).toEqual([
        expect.objectContaining({ attribute: "shelter.S", profileVersion: held!.version, severity: "safety" }),
      ]);

      // a strong source ends the hold: the value enters, the open task goes as superseded
      const guide = await insertSource(tx, "pilot_guide", 0.9);
      await tx.update(sources).set({ status: "approved" }).where(eq(sources.id, guide));
      await insertTextFact(tx, objectId, guide, { attribute: "shelter.S", value: 0.7, observedAt: "2026-09-15", confidence: 0.9 });
      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "created" });
      const after = await latestProfile(tx, objectId);
      expect(after!.attributes["shelter.S"]).toBe(0.7);
      expect(after!.gaps.filter((g) => g.attribute === "shelter.S")).toEqual([]);
      expect((await tasks()).filter((t) => t.status === "open")).toEqual([]);
    }));
});
