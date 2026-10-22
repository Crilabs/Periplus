import { and, asc, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { changeEvents, evaluationProfiles, places, profiles, reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { newId } from "@/lib/domain/ids";
import { insertComputation, insertPlace, insertSource, insertTextFact } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";
import { insertNamedObject, insertTestRun } from "@/test/text";

/*
 * consolidateGeo against the database, inside withRollback (facts and computations inserted directly), except the
 * parallel test, which commits a fresh synthetic object and asserts only on its rows (ruling M5-P20).
 */

/** The database's date: test objects are valid from it. */
let today = "";
let tomorrow = "";
beforeAll(async () => {
  const { rows } = await testDb().execute<{ today: string; tomorrow: string }>(
    sql`select current_date::text as today, (current_date + 1)::text as tomorrow`,
  );
  today = rows[0]!.today;
  tomorrow = rows[0]!.tomorrow;
});

async function versionsOf(db: Db, objectId: string) {
  return db
    .select({ version: profiles.version, validFrom: profiles.validFrom, runId: profiles.runId, attributes: profiles.attributes })
    .from(profiles)
    .where(eq(profiles.geoObjectId, objectId))
    .orderBy(asc(profiles.version));
}

async function eventsOf(db: Db, objectId: string) {
  return db
    .select({
      type: changeEvents.type,
      attribute: changeEvents.attribute,
      oldValue: changeEvents.oldValue,
      newValue: changeEvents.newValue,
      severity: changeEvents.severity,
      profileVersion: changeEvents.profileVersion,
      details: changeEvents.details,
      runId: changeEvents.runId,
    })
    .from(changeEvents)
    .where(eq(changeEvents.geoObjectId, objectId))
    .orderBy(asc(changeEvents.seq));
}

async function tasksOf(db: Db, objectId: string, attribute: string) {
  return db
    .select({ id: reviewTasks.id, kind: reviewTasks.kind, status: reviewTasks.status, context: reviewTasks.context, priority: reviewTasks.priority })
    .from(reviewTasks)
    .where(and(eq(reviewTasks.subjectType, "profile_attribute"), eq(reviewTasks.subjectId, `${objectId}:${attribute}`)));
}

/** A confirmed anchorage with a computed shelter, depth and seabed away from class boundaries. */
async function anchorage(db: Db): Promise<string> {
  const { objectId } = await insertPlace(db);
  await insertComputation(db, objectId, "shelter", { "shelter.N": 0.6 });
  await insertComputation(db, objectId, "depth", { "depth.min": 4 }, { confidence: 0.85 });
  return objectId;
}

/**
 * A committed synthetic place far from every tile the tests build (a committed place at 21.0° E / 35.2° N joins the
 * tiles of the geometry scenes and their place counts); `cleanup` ends it and dismisses its open tasks, so area, tile
 * and review queries never see it. Only its own rows are asserted (ruling M5-P20).
 */
async function committedPlace(db: Db): Promise<{ objectId: string; cleanup: () => Promise<void> }> {
  const lon = -150.1;
  const lat = -50.1;
  const objectId = await insertNamedObject(db, { type: "bay", names: [{ name: `Parallel ${newId()}` }], lon, lat });
  await db.insert(places).values({ geoObjectId: objectId, kind: "anchorage", status: "confirmed", position: geomFromGeoJson({ type: "Point", coordinates: [lon, lat] }) });
  const cleanup = async () => {
    await db.execute(sql`update review_tasks set status = 'dismissed' where left(subject_id, 37) = ${`${objectId}:`} and status = 'open'`);
    await db.execute(sql`update places set valid_to = current_date where geo_object_id = ${objectId} and valid_to is null`);
    await db.execute(sql`update geo_objects set valid_to = current_date where id = ${objectId} and valid_to is null`);
  };
  return { objectId, cleanup };
}

type Side = { value: unknown; factIds: string[] };

/** Decides a task as a review decision would: one decision row, status `decided`. */
async function decide(tx: Db, taskId: string): Promise<void> {
  await tx.insert(reviewDecisions).values({ taskId, decision: { action: "discard_change" }, decidedBy: "test" });
  await tx.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.id, taskId));
}

/**
 * Runs `run` while another connection decides `taskId`: `lock-first` locks the task row, waits until `run` blocks on
 * it, then decides and commits; `decide-first` decides (uncommitted), waits until `run` blocks, then commits. Waits at
 * most 5 s for the block.
 */
async function decideDuring<T>(db: Db, taskId: string, order: "lock-first" | "decide-first", run: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let ready!: (pid: number) => void;
  const isReady = new Promise<number>((resolve) => (ready = resolve));
  const holder = db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    if (order === "lock-first") await tx.execute(sql`select id from review_tasks where id = ${taskId} for update`);
    else await decide(tx, taskId);
    ready(rows[0]!.pid);
    await held;
    if (order === "lock-first") await decide(tx, taskId);
  });
  const pid = await isReady;
  const running = run();
  running.catch(() => undefined);
  for (let n = 0; n < 100; n++) {
    const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`);
    if (rows[0]!.n > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  release();
  await holder;
  return running;
}

describe("consolidateGeo", () => {
  it("first consolidation writes version 1 with valid_from = run date", () =>
    withRollback(async (tx) => {
      const objectId = await anchorage(tx);
      const runId = await insertTestRun(tx);
      const { rows } = await tx.execute<{ day: string }>(sql`select (created_at at time zone 'UTC')::date::text as day from runs where id = ${runId}`);

      const r = await consolidateGeo(tx, objectId, { runId });
      expect(r).toEqual({ status: "created", version: 1, events: 1, tasks: 0 });
      const [v1] = await versionsOf(tx, objectId);
      expect(v1).toMatchObject({ version: 1, validFrom: rows[0]!.day, runId });
      expect(v1!.attributes).toMatchObject({ "shelter.N": 0.6, "depth.min": 4, "place.status": "confirmed" });
      expect(await eventsOf(tx, objectId)).toEqual([
        { type: "place_new", attribute: null, oldValue: null, newValue: "confirmed", severity: "info", profileVersion: 1, details: {}, runId },
      ]);
    }));

  it("a second consolidation creates nothing", () =>
    withRollback(async (tx) => {
      const objectId = await anchorage(tx);
      await insertTextFact(tx, objectId, await insertSource(tx, "pilot_guide", 0.9), { attribute: "holding", value: "good", confidence: 0.9 });
      await consolidateGeo(tx, objectId, { today });
      expect(await consolidateGeo(tx, objectId, { today })).toEqual({ status: "unchanged", version: 1, events: 0, tasks: 0 });
      expect(await versionsOf(tx, objectId)).toHaveLength(1);
      expect(await eventsOf(tx, objectId)).toHaveLength(1);
    }));

  it("one day later without new facts creates nothing", () =>
    withRollback(async (tx) => {
      const objectId = await anchorage(tx);
      await insertTextFact(tx, objectId, await insertSource(tx, "pilot_guide", 0.9), { attribute: "holding", value: "good", confidence: 0.9 });
      await consolidateGeo(tx, objectId, { today });
      expect(await consolidateGeo(tx, objectId, { today: tomorrow })).toEqual({ status: "unchanged", version: 1, events: 0, tasks: 0 });
      expect(await versionsOf(tx, objectId)).toHaveLength(1);
    }));

  it("a new pilot guide fact creates version 2 and one changed event with old and new value", () =>
    withRollback(async (tx) => {
      const objectId = await anchorage(tx);
      await insertTextFact(tx, objectId, await insertSource(tx, "forum", 0.4), { attribute: "services.water", value: true, observedAt: "2025-07-01" });
      await consolidateGeo(tx, objectId, { today });
      await insertTextFact(tx, objectId, await insertSource(tx, "pilot_guide", 0.9), { attribute: "services.water", value: false, observedAt: "2026-07-01", confidence: 0.9 });

      expect(await consolidateGeo(tx, objectId, { today: tomorrow })).toEqual({ status: "created", version: 2, events: 1, tasks: 0 });
      const versions = await versionsOf(tx, objectId);
      expect(versions.map((v) => [v.version, v.validFrom, v.attributes["services.water"]])).toEqual([
        [1, today, true],
        [2, tomorrow, false],
      ]);
      expect((await eventsOf(tx, objectId)).filter((e) => e.type !== "place_new")).toEqual([
        { type: "changed", attribute: "services.water", oldValue: true, newValue: false, severity: "notable", profileVersion: 2, details: {}, runId: null },
      ]);
    }));

  it("an uncertain change opens one task over three runs", () =>
    withRollback(async (tx) => {
      const objectId = await anchorage(tx);
      await insertTextFact(tx, objectId, await insertSource(tx, "pilot_guide", 0.9), { attribute: "services.water", value: true, observedAt: "2026-06-01", confidence: 0.9 });
      await consolidateGeo(tx, objectId, { today });
      const forum = await insertSource(tx, "forum", 0.4);
      const forumFact = await insertTextFact(tx, objectId, forum, { attribute: "services.water", value: false, observedAt: "2026-07-01" });

      const results = [];
      for (let n = 0; n < 3; n++) results.push(await consolidateGeo(tx, objectId, { today }));
      expect(results).toEqual([
        { status: "unchanged", version: 1, events: 1, tasks: 1 },
        { status: "unchanged", version: 1, events: 0, tasks: 0 },
        { status: "unchanged", version: 1, events: 0, tasks: 0 },
      ]);
      const tasks = await tasksOf(tx, objectId, "services.water");
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        kind: "uncertain_change",
        status: "open",
        priority: 1,
        context: { attribute: "services.water", oldValue: true, newValue: false, factIds: [forumFact], sources: [`source:${forum}`], geoObjectId: objectId },
      });
      const key = (tasks[0]!.context as { key: string }).key;
      expect(key).toMatch(/^[0-9a-f]{16}$/);
      const uncertain = (await eventsOf(tx, objectId)).filter((e) => e.type !== "place_new");
      expect(uncertain).toEqual([
        { type: "uncertain", attribute: "services.water", oldValue: true, newValue: false, severity: "notable", profileVersion: 1, details: { key, taskId: tasks[0]!.id }, runId: null },
      ]);
      expect((await versionsOf(tx, objectId)).map((v) => v.attributes["services.water"])).toEqual([true]);

      // a newer uncertain change of the same attribute updates the open task (one per subject, ruling M5-P9), no event
      const second = await insertTextFact(tx, objectId, forum, { attribute: "services.water", value: false, observedAt: "2026-08-01" });
      expect(await consolidateGeo(tx, objectId, { today })).toEqual({ status: "unchanged", version: 1, events: 0, tasks: 0 });
      const updated = await tasksOf(tx, objectId, "services.water");
      expect(updated).toHaveLength(1);
      expect(updated[0]!.id).toBe(tasks[0]!.id);
      expect(updated[0]!.context).toMatchObject({ factIds: [forumFact, second].sort() });
      expect((updated[0]!.context as { key: string }).key).not.toBe(key);
    }));

  it("a conflict opens one conflict task with its key", () =>
    withRollback(async (tx) => {
      const objectId = await anchorage(tx);
      await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.6), { attribute: "holding", value: "good", observedAt: "2026-07-01" });
      await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.5), { attribute: "holding", value: "poor", observedAt: "2026-07-02" });
      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "created", tasks: 1 });
      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "unchanged", tasks: 0, events: 0 });
      const tasks = await tasksOf(tx, objectId, "holding");
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ kind: "conflict", priority: 1, context: { attribute: "holding", a: { value: "good" }, b: { value: "poor" }, geoObjectId: objectId } });
      const [v1] = await tx.select({ conflicts: profiles.conflicts }).from(profiles).where(eq(profiles.geoObjectId, objectId));
      expect(v1!.conflicts[0]!.key).toBe((tasks[0]!.context as { key: string }).key);
    }));

  it("a rejected or merged place's open profile tasks are dismissed as object_ended; its profile stays (final review M-6)", () =>
    withRollback(async (tx) => {
      for (const end of ["rejected", "merged"] as const) {
        const { objectId, placeId } = await insertPlace(tx);
        await insertComputation(tx, objectId, "shelter", { "shelter.N": 0.6 });
        await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.6), { attribute: "holding", value: "good", observedAt: "2026-07-01" });
        await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.5), { attribute: "holding", value: "poor", observedAt: "2026-07-02" });
        expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "created", tasks: 1 });
        if (end === "rejected") await tx.update(places).set({ status: "rejected", statusReason: "review" }).where(eq(places.id, placeId));
        else {
          const target = await insertPlace(tx, { name: "Ziel" });
          await tx.update(places).set({ status: "rejected", statusReason: "merged", mergedIntoId: target.placeId }).where(eq(places.id, placeId));
        }
        expect(await consolidateGeo(tx, objectId, { today })).toEqual({ status: "skipped", version: null, events: 0, tasks: 0 });
        const tasks = await tasksOf(tx, objectId, "holding");
        expect(tasks, end).toMatchObject([{ kind: "conflict", status: "dismissed", context: { dismissedReason: "object_ended" } }]);
        expect((await versionsOf(tx, objectId)).map((v) => v.version), end).toEqual([1]);
      }
    }));

  it("an evaluation run writes no profile, no event and no task", () =>
    withRollback(async (tx) => {
      const objectId = await anchorage(tx);
      await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.6), { attribute: "holding", value: "good", observedAt: "2026-07-01" });
      await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.5), { attribute: "holding", value: "poor", observedAt: "2026-07-02" });
      const runId = await insertTestRun(tx);

      expect(await consolidateGeo(tx, objectId, { runId, mode: "evaluation", rulesVersion: "v1", today })).toEqual({ status: "evaluated", version: null, events: 0, tasks: 0 });
      // a second evaluation of the same run replaces its row
      await consolidateGeo(tx, objectId, { runId, mode: "evaluation", rulesVersion: "v1", today });
      expect(await versionsOf(tx, objectId)).toEqual([]);
      expect(await eventsOf(tx, objectId)).toEqual([]);
      expect(await tasksOf(tx, objectId, "holding")).toEqual([]);
      const rows = await tx.select().from(evaluationProfiles).where(eq(evaluationProfiles.geoObjectId, objectId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ runId, rulesVersion: "v1", factSchemaVersion: getConfig().factSchema.version, attributes: { "shelter.N": 0.6, holding: "good" } });
      await expect(consolidateGeo(tx, objectId, { mode: "evaluation", rulesVersion: "v1" })).rejects.toThrow(/runId and rulesVersion/);
    }));

  it("a candidate confirmed by evidence is confirmed in the profile of the same run and emits place_new (spec 17)", () =>
    withRollback(async (tx) => {
      const { objectId, placeId } = await insertPlace(tx, { status: "candidate" });
      await insertTextFact(tx, objectId, await insertSource(tx, "pilot_guide"), { attribute: "holding", value: "good", docType: "pilot_guide" });
      const runId = await insertTestRun(tx);
      const r = await consolidateGeo(tx, objectId, { runId });
      expect(r).toMatchObject({ status: "created", version: 1 });
      const [v1] = await versionsOf(tx, objectId);
      expect(v1!.attributes).toMatchObject({ "place.status": "confirmed", holding: "good" });
      expect((await eventsOf(tx, objectId)).map((e) => [e.type, e.newValue])).toEqual([["place_new", "confirmed"]]);
      const [place] = await tx.select({ status: places.status }).from(places).where(eq(places.id, placeId));
      expect(place!.status).toBe("confirmed");
    }));

  it("an evaluation run never confirms or switches the kind (spec 17)", () =>
    withRollback(async (tx) => {
      const { objectId, placeId } = await insertPlace(tx, { status: "candidate" });
      await insertTextFact(tx, objectId, await insertSource(tx, "pilot_guide"), { attribute: "holding", value: "good", docType: "pilot_guide" });
      await insertTextFact(tx, objectId, await insertSource(tx, "pilot_guide"), { attribute: "place.kind_evidence", value: "marina", docType: "pilot_guide" });
      const runId = await insertTestRun(tx);
      await consolidateGeo(tx, objectId, { runId, mode: "evaluation", rulesVersion: getConfig().consolidation.version, today });
      const [place] = await tx.select({ status: places.status, kind: places.kind, publicId: places.publicId }).from(places).where(eq(places.id, placeId));
      expect(place).toEqual({ status: "candidate", kind: "anchorage", publicId: null });
      const decisions = await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, placeId));
      expect(decisions).toEqual([]);
      const [row] = await tx.select().from(evaluationProfiles).where(eq(evaluationProfiles.geoObjectId, objectId));
      expect(row!.attributes).toMatchObject({ "place.status": "candidate", "place.kind": "anchorage" });
    }));

  it("depth scenario: two contradicting 0.6 texts leave the profile and create no event", () =>
    withRollback(async (tx) => {
      const objectId = await anchorage(tx);
      await consolidateGeo(tx, objectId, { today });
      await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.6), { attribute: "depth.min", value: 2.5, confidence: 0.6 });
      await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.6), { attribute: "depth.min", value: 6, confidence: 0.6 });

      expect(await consolidateGeo(tx, objectId, { today })).toEqual({ status: "unchanged", version: 1, events: 0, tasks: 0 });
      expect((await versionsOf(tx, objectId)).map((v) => v.attributes["depth.min"])).toEqual([4]);
      expect(await tasksOf(tx, objectId, "depth.min")).toEqual([]);
    }));

  it("a stale open task is dismissed when the change becomes supported (ruling M5-F-R3 I-4)", () =>
    withRollback(async (tx) => {
      const objectId = await anchorage(tx);
      await insertTextFact(tx, objectId, await insertSource(tx, "pilot_guide", 0.9), { attribute: "services.water", value: true, observedAt: "2026-06-01", confidence: 0.9 });
      await consolidateGeo(tx, objectId, { today });
      await insertTextFact(tx, objectId, await insertSource(tx, "forum", 0.4), { attribute: "services.water", value: false, observedAt: "2026-07-01" });
      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "unchanged", tasks: 1 });

      // a second independent forum: the change is supported now, the open task has no draft any more
      await insertTextFact(tx, objectId, await insertSource(tx, "forum", 0.4), { attribute: "services.water", value: false, observedAt: "2026-07-02" });
      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "created", version: 2, tasks: 0 });
      const [task] = await tasksOf(tx, objectId, "services.water");
      expect(task).toMatchObject({ status: "dismissed", context: { dismissedReason: "superseded" } });
      expect((await versionsOf(tx, objectId)).map((v) => v.attributes["services.water"])).toEqual([true, false]);
    }));

  it("an open conflict task gets the newest sides while its key stays (ruling M5-F-R3 M-3)", () =>
    withRollback(async (tx) => {
      const objectId = await anchorage(tx);
      await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.6), { attribute: "holding", value: "good", observedAt: "2026-07-01" });
      await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.5), { attribute: "holding", value: "poor", observedAt: "2026-07-02" });
      await consolidateGeo(tx, objectId, { today });
      const [before] = await tasksOf(tx, objectId, "holding");
      const sideOf = (context: unknown, value: string) =>
        [(context as { a: Side }).a, (context as { b: Side }).b].find((side) => side.value === value)!;
      expect(sideOf(before!.context, "poor").factIds).toHaveLength(1);
      expect(before!.context).toMatchObject({ others: [] });

      // a weak third source joins "poor": the same two value groups, the same key
      const more = await insertTextFact(tx, objectId, await insertSource(tx, "forum", 0.1), { attribute: "holding", value: "poor", observedAt: "2026-07-03" });
      await consolidateGeo(tx, objectId, { today });
      const [after] = await tasksOf(tx, objectId, "holding");
      expect(after!.id).toBe(before!.id);
      expect((after!.context as { key: string }).key).toBe((before!.context as { key: string }).key);
      expect(sideOf(after!.context, "poor").factIds).toContain(more);
    }));

  it("a previous valid_from later than the run date is kept (ruling M5-A-R2)", () =>
    withRollback(async (tx) => {
      const objectId = await anchorage(tx);
      await insertTextFact(tx, objectId, await insertSource(tx, "forum", 0.4), { attribute: "services.water", value: true, observedAt: "2025-07-01" });
      await consolidateGeo(tx, objectId, { today: tomorrow });
      await insertTextFact(tx, objectId, await insertSource(tx, "pilot_guide", 0.9), { attribute: "services.water", value: false, observedAt: "2026-07-01", confidence: 0.9 });
      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "created", version: 2 });
      expect((await versionsOf(tx, objectId)).map((v) => [v.version, v.validFrom])).toEqual([
        [1, tomorrow],
        [2, tomorrow],
      ]);
    }));

  it("an unknown run id is an error, not today (ruling M5-F-R2 M-6)", () =>
    withRollback(async (tx) => {
      const objectId = await anchorage(tx);
      await expect(consolidateGeo(tx, objectId, { runId: newId() })).rejects.toThrow(/run .* not found/);
    }));

  it("refuses to run outside READ COMMITTED (ruling M5-F-R2 M-2)", () =>
    withRollback(
      async (tx) => {
        const objectId = await anchorage(tx);
        await expect(consolidateGeo(tx, objectId, { today })).rejects.toThrow(/READ COMMITTED/);
      },
      { isolationLevel: "repeatable read" },
    ));

  it("an object without a fact level is skipped", () =>
    withRollback(async (tx) => {
      const objectId = await insertNamedObject(tx, { type: "settlement", names: [{ name: "Chora" }], lon: 21.0, lat: 35.2 });
      expect(await consolidateGeo(tx, objectId, { today })).toEqual({ status: "skipped", version: null, events: 0, tasks: 0 });
      expect(await versionsOf(tx, objectId)).toEqual([]);
    }));

  it("two parallel consolidations write one version", async () => {
    const db = testDb();
    const { objectId, cleanup } = await committedPlace(db);
    try {
      const results = await Promise.all([consolidateGeo(db, objectId, { today }), consolidateGeo(db, objectId, { today })]);
      expect(results.map((r) => r.status).sort()).toEqual(["created", "unchanged"]);
      expect((await versionsOf(db, objectId)).map((v) => v.version)).toEqual([1]);
      expect((await eventsOf(db, objectId)).map((e) => [e.type, e.profileVersion])).toEqual([["place_new", 1]]);
    } finally {
      await cleanup();
    }
  });

  it("two parallel consolidations open one task and write its event once (ruling M5-F-R2 M-5)", async () => {
    const db = testDb();
    const { objectId, cleanup } = await committedPlace(db);
    try {
      await insertTextFact(db, objectId, await insertSource(db, "pilot_guide", 0.9), { attribute: "services.water", value: true, observedAt: "2026-06-01", confidence: 0.9 });
      await consolidateGeo(db, objectId, { today });
      await insertTextFact(db, objectId, await insertSource(db, "forum", 0.4), { attribute: "services.water", value: false, observedAt: "2026-07-01" });

      const results = await Promise.all([consolidateGeo(db, objectId, { today }), consolidateGeo(db, objectId, { today })]);
      expect(results.map((r) => r.tasks).sort()).toEqual([0, 1]);
      expect((await tasksOf(db, objectId, "services.water")).map((t) => [t.kind, t.status])).toEqual([["uncertain_change", "open"]]);
      expect((await eventsOf(db, objectId)).map((e) => e.type)).toEqual(["place_new", "uncertain"]);
    } finally {
      await cleanup();
    }
  });

  it("a task decided between two runs keeps its context (ruling M5-F-R2)", async () => {
    const db = testDb();
    const { objectId, cleanup } = await committedPlace(db);
    try {
      await insertTextFact(db, objectId, await insertSource(db, "pilot_guide", 0.9), { attribute: "services.water", value: true, observedAt: "2026-06-01", confidence: 0.9 });
      await consolidateGeo(db, objectId, { today });
      const forum = await insertSource(db, "forum", 0.4);
      await insertTextFact(db, objectId, forum, { attribute: "services.water", value: false, observedAt: "2026-07-01" });
      await consolidateGeo(db, objectId, { today });
      const [task] = await tasksOf(db, objectId, "services.water");
      const decidedContext = task!.context as { key: string };
      // a newer forum document: the next run drafts another key for the same subject
      await insertTextFact(db, objectId, forum, { attribute: "services.water", value: false, observedAt: "2026-08-01" });

      // the admin decides the open task while the run is about to take it over
      await decideDuring(db, task!.id, "lock-first", () => consolidateGeo(db, objectId, { today }));

      const tasks = await tasksOf(db, objectId, "services.water");
      const decided = tasks.find((t) => t.id === task!.id)!;
      expect(decided.status).toBe("decided");
      expect(decided.context).toEqual(decidedContext);
      const open = tasks.filter((t) => t.status === "open");
      expect(open).toHaveLength(1);
      expect((open[0]!.context as { key: string }).key).not.toBe(decidedContext.key);
    } finally {
      await cleanup();
    }
  });

  it("a key decided while the run waits is not opened again (ruling M5-F-R2 M-3)", async () => {
    const db = testDb();
    const { objectId, cleanup } = await committedPlace(db);
    try {
      await insertTextFact(db, objectId, await insertSource(db, "pilot_guide", 0.9), { attribute: "services.water", value: true, observedAt: "2026-06-01", confidence: 0.9 });
      await consolidateGeo(db, objectId, { today });
      await insertTextFact(db, objectId, await insertSource(db, "forum", 0.4), { attribute: "services.water", value: false, observedAt: "2026-07-01" });
      await consolidateGeo(db, objectId, { today });
      const [task] = await tasksOf(db, objectId, "services.water");

      // the decision is written but not committed when the run (which saw the task open) reaches its tasks
      await decideDuring(db, task!.id, "decide-first", () => consolidateGeo(db, objectId, { today }));

      expect((await tasksOf(db, objectId, "services.water")).map((t) => [t.id, t.status])).toEqual([[task!.id, "decided"]]);
      expect((await eventsOf(db, objectId)).map((e) => e.type)).toEqual(["place_new", "uncertain"]);
    } finally {
      await cleanup();
    }
  });
});