import { and, asc, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { changeEvents, evaluationProfiles, places, profiles, reviewTasks } from "@/lib/db/schema";
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
      expect(rows[0]).toMatchObject({ runId, rulesVersion: "v1", factSchemaVersion: "v2", attributes: { "shelter.N": 0.6, holding: "good" } });
      await expect(consolidateGeo(tx, objectId, { mode: "evaluation", rulesVersion: "v1" })).rejects.toThrow(/runId and rulesVersion/);
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

  it("an object without a fact level is skipped", () =>
    withRollback(async (tx) => {
      const objectId = await insertNamedObject(tx, { type: "settlement", names: [{ name: "Chora" }], lon: 21.0, lat: 35.2 });
      expect(await consolidateGeo(tx, objectId, { today })).toEqual({ status: "skipped", version: null, events: 0, tasks: 0 });
      expect(await versionsOf(tx, objectId)).toEqual([]);
    }));

  it("two parallel consolidations write one version", async () => {
    // Committed: a fresh synthetic object with its own uuid and no facts; only its own rows are asserted (ruling
    // M5-P20). It lies far from every tile the tests build (a committed place at 21.0° E / 35.2° N joins the tiles of
    // the geometry scenes and their place counts), and is ended afterwards, so area and tile queries never see it.
    const db = testDb();
    const lon = -150.1;
    const lat = -50.1;
    const objectId = await insertNamedObject(db, { type: "bay", names: [{ name: `Parallel ${newId()}` }], lon, lat });
    await db.insert(places).values({ geoObjectId: objectId, kind: "anchorage", status: "confirmed", position: geomFromGeoJson({ type: "Point", coordinates: [lon, lat] }) });
    try {
      const results = await Promise.all([consolidateGeo(db, objectId, { today }), consolidateGeo(db, objectId, { today })]);
      expect(results.map((r) => r.status).sort()).toEqual(["created", "unchanged"]);
      expect((await versionsOf(db, objectId)).map((v) => v.version)).toEqual([1]);
      expect((await eventsOf(db, objectId)).map((e) => [e.type, e.profileVersion])).toEqual([["place_new", 1]]);
    } finally {
      await db.execute(sql`update places set valid_to = current_date where geo_object_id = ${objectId} and valid_to is null`);
      await db.execute(sql`update geo_objects set valid_to = current_date where id = ${objectId} and valid_to is null`);
    }
  });
});
