import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { reviewTasks, sources } from "@/lib/db/schema";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { newId } from "@/lib/domain/ids";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { latestProfile } from "@/lib/domain/timeline";
import { insertComputation, insertExtraction, insertMention, insertMentionFact, insertPlace, insertSource } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";

/*
 * GR-1 (SAF-1): a computed empty list is never support for „no prohibition / no hazard“. A text entry of a safety list
 * leaves the profile only by an explicit review removal, a withdrawn source, or (computed entries) a newer computation
 * that no longer has it. Everything in withRollback on synthetic places outside the pilot box (own coordinates).
 */

let today = "";
let tomorrow = "";
beforeAll(async () => {
  const { rows } = await testDb().execute<{ today: string; tomorrow: string }>(sql`select current_date::text as today, (current_date + 1)::text as tomorrow`);
  today = rows[0]!.today;
  tomorrow = rows[0]!.tomorrow;
});

const ban = { kind: "anchoring", months: null };
const rock = { kind: "rock", name: null };

/** A confirmed place with a restriction computation `prohibitions: []`, one guide mention and its extraction run. */
async function bannedPlace(tx: Db, lon: number, lat: number) {
  const place = await insertPlace(tx, { lon, lat, name: `Saf ${newId().slice(-6)}` });
  await insertComputation(tx, place.objectId, "restriction", { prohibitions: [] }, { confidence: 0.9 });
  const sourceId = await insertSource(tx, "pilot_guide", 0.9);
  const mention = await insertMention(tx, place.objectId, { sourceId, observedAt: "2026-06-01" });
  const run = await insertExtraction(tx, place.objectId, mention, { startedAt: new Date("2026-10-18T10:00:00Z") });
  await insertMentionFact(tx, place.objectId, mention, run, { attribute: "prohibitions", value: [ban], observedAt: "2026-06-01", confidence: 0.9 });
  await insertMentionFact(tx, place.objectId, mention, run, { attribute: "hazards", value: [rock], observedAt: "2026-06-01", confidence: 0.9 });
  await consolidateGeo(tx, place.objectId, { today });
  const p1 = await latestProfile(tx, place.objectId);
  expect(p1?.attributes["prohibitions"]).toEqual([ban]);
  return { ...place, sourceId, mention, run };
}

async function eventsOf(tx: Db, objectId: string) {
  const { rows } = await tx.execute<{ type: string; attribute: string | null; new_value: unknown }>(
    sql`select type::text, attribute, new_value from change_events where geo_object_id = ${objectId} order by seq`,
  );
  return rows;
}

async function openTask(tx: Db, objectId: string, attribute: string) {
  const [task] = await tx
    .select({ id: reviewTasks.id, priority: reviewTasks.priority, context: reviewTasks.context })
    .from(reviewTasks)
    .where(and(eq(reviewTasks.subjectId, `${objectId}:${attribute}`), eq(reviewTasks.kind, "uncertain_change"), eq(reviewTasks.status, "open")));
  return task;
}

describe("safety lists are never lifted by omission (GR-1, SAF-1)", () => {
  it("a model/prompt switch that makes the old run ineligible keeps the ban, marks it in_review and opens a review", async () => {
    await withRollback(async (tx) => {
      const a = await bannedPlace(tx, 19.751, 34.651);
      // config/models.json moves on: the old run no longer matches the active configuration
      await tx.execute(sql`update extraction_runs set prompt_version = prompt_version - 1 where id = ${a.run}`);
      await consolidateGeo(tx, a.objectId, { today: tomorrow });
      const p2 = await latestProfile(tx, a.objectId);
      expect(p2?.attributes["prohibitions"]).toEqual([ban]);
      expect(p2?.attributes["hazards"]).toEqual([rock]);
      // the entry stays with its old provenance, marked while its removal waits
      expect(p2?.provenance["prohibitions"]?.entryMarkers).toEqual({ anchoring: "in_review" });
      expect(p2?.provenance["prohibitions"]?.entryFactIds?.["anchoring"]).toHaveLength(1);
      expect((await eventsOf(tx, a.objectId)).filter((e) => e.type === "changed" && e.attribute === "prohibitions")).toEqual([]);
      const task = await openTask(tx, a.objectId, "prohibitions");
      expect(task).toMatchObject({ priority: 2, context: { oldValue: [ban], newValue: [] } });
    });
  });

  it("a younger reprocess run that misses the ban keeps it", async () => {
    await withRollback(async (tx) => {
      const a = await bannedPlace(tx, 19.752, 34.652);
      const run2 = await insertExtraction(tx, a.objectId, a.mention, { startedAt: new Date("2026-10-19T10:00:00Z") });
      await insertMentionFact(tx, a.objectId, a.mention, run2, { attribute: "holding", value: "good", observedAt: "2026-06-01" });
      await consolidateGeo(tx, a.objectId, { today: tomorrow });
      const p2 = await latestProfile(tx, a.objectId);
      expect(p2?.attributes["prohibitions"]).toEqual([ban]);
      expect(p2?.attributes["hazards"]).toEqual([rock]);
      expect(await openTask(tx, a.objectId, "prohibitions")).toBeDefined();
    });
  });

  it("accepting the proposed removal takes the ban out through a removal decision", async () => {
    await withRollback(async (tx) => {
      const a = await bannedPlace(tx, 19.753, 34.653);
      await tx.execute(sql`update extraction_runs set prompt_version = prompt_version - 1 where id = ${a.run}`);
      await consolidateGeo(tx, a.objectId, { today: tomorrow });
      const task = (await openTask(tx, a.objectId, "prohibitions"))!;
      await decideReviewTask(tx, { taskId: task.id, decision: { action: "accept_change" }, decidedBy: "test", taskKey: (task.context as { key: string }).key });
      const { rows } = await tx.execute<{ value: unknown }>(sql`select value from facts where geo_object_id = ${a.objectId} and review_decision_id is not null`);
      expect(rows.map((r) => r.value)).toEqual([{ remove: [{ kind: "anchoring" }] }]);
      await consolidateGeo(tx, a.objectId, { today: tomorrow });
      const p3 = await latestProfile(tx, a.objectId);
      expect(p3?.attributes["prohibitions"]).toEqual([]);
      expect(p3?.provenance["prohibitions"]?.entryMarkers).toBeUndefined();
      expect((await eventsOf(tx, a.objectId)).filter((e) => e.type === "changed" && e.attribute === "prohibitions").map((e) => e.new_value)).toEqual([[]]);
    });
  });

  it("discarding the proposal keeps the ban without the marker", async () => {
    await withRollback(async (tx) => {
      const a = await bannedPlace(tx, 19.754, 34.654);
      await tx.execute(sql`update extraction_runs set prompt_version = prompt_version - 1 where id = ${a.run}`);
      await consolidateGeo(tx, a.objectId, { today: tomorrow });
      const task = (await openTask(tx, a.objectId, "prohibitions"))!;
      await decideReviewTask(tx, { taskId: task.id, decision: { action: "discard_change" }, decidedBy: "test", taskKey: (task.context as { key: string }).key });
      await consolidateGeo(tx, a.objectId, { today: tomorrow });
      const p3 = await latestProfile(tx, a.objectId);
      expect(p3?.attributes["prohibitions"]).toEqual([ban]);
      expect(p3?.provenance["prohibitions"]?.entryMarkers).toBeUndefined();
      expect(await openTask(tx, a.objectId, "prohibitions")).toBeUndefined();
    });
  });

  it("ending the source still withdraws its ban at once (ruling M6-H-R1)", async () => {
    await withRollback(async (tx) => {
      const a = await bannedPlace(tx, 19.755, 34.655);
      await tx.update(sources).set({ status: "rejected" }).where(eq(sources.id, a.sourceId));
      await consolidateGeo(tx, a.objectId, { today: tomorrow });
      const p2 = await latestProfile(tx, a.objectId);
      expect(p2?.attributes["prohibitions"]).toEqual([]);
      expect(await openTask(tx, a.objectId, "prohibitions")).toBeUndefined();
    });
  });

  it("a newer computation without the restricted area removes the computed entry, the text ban stays", async () => {
    await withRollback(async (tx) => {
      const place = await insertPlace(tx, { lon: 19.756, lat: 34.656, name: `Saf ${newId().slice(-6)}` });
      const area = { kind: "military", restrictedAreaId: newId(), sourceRef: "test/military/1", share: 1, anchoringBan: true };
      await insertComputation(tx, place.objectId, "restriction", { prohibitions: [area] }, { confidence: 0.9, createdAt: new Date("2026-10-01T10:00:00Z") });
      const sourceId = await insertSource(tx, "pilot_guide", 0.9);
      const mention = await insertMention(tx, place.objectId, { sourceId, observedAt: "2026-06-01" });
      const run = await insertExtraction(tx, place.objectId, mention);
      await insertMentionFact(tx, place.objectId, mention, run, { attribute: "prohibitions", value: [ban], observedAt: "2026-06-01", confidence: 0.9 });
      await consolidateGeo(tx, place.objectId, { today });
      expect((await latestProfile(tx, place.objectId))?.attributes["prohibitions"]).toEqual([ban, area]);
      await insertComputation(tx, place.objectId, "restriction", { prohibitions: [] }, { confidence: 0.9, createdAt: new Date("2026-10-05T10:00:00Z") });
      await consolidateGeo(tx, place.objectId, { today: tomorrow });
      const p2 = await latestProfile(tx, place.objectId);
      expect(p2?.attributes["prohibitions"]).toEqual([ban]);
      expect(p2?.provenance["prohibitions"]?.entryMarkers).toBeUndefined();
      expect(await openTask(tx, place.objectId, "prohibitions")).toBeUndefined();
    });
  });
});

describe("a removal is consumed once a younger source names the entry again (GR-12, wave-1 review I-1)", () => {
  /**
   * The admin removes the entry (accepted proposal after a prompt switch), a source observed after the removal names
   * it again, then that fact stops counting too (the next prompt switch). The old removal must not lift the entry:
   * it stays in its old form, marked in_review, with a task (GR-1).
   */
  async function removedThenRenamed(tx: Db, attribute: "prohibitions" | "hazards", entry: unknown, lon: number, lat: number) {
    const a = await bannedPlace(tx, lon, lat);
    await tx.execute(sql`update extraction_runs set prompt_version = prompt_version - 1 where id = ${a.run}`);
    await consolidateGeo(tx, a.objectId, { today });
    const task = (await openTask(tx, a.objectId, attribute))!;
    await decideReviewTask(tx, { taskId: task.id, decision: { action: "accept_change" }, decidedBy: "test", taskKey: (task.context as { key: string }).key });
    await consolidateGeo(tx, a.objectId, { today });
    expect((await latestProfile(tx, a.objectId))?.attributes[attribute] ?? []).toEqual([]);
    // a source observed after the removal names the entry again
    const s2 = await insertSource(tx, "pilot_guide", 0.9);
    const m2 = await insertMention(tx, a.objectId, { sourceId: s2, observedAt: tomorrow });
    const r2 = await insertExtraction(tx, a.objectId, m2, { startedAt: new Date("2026-10-19T10:00:00Z") });
    await insertMentionFact(tx, a.objectId, m2, r2, { attribute, value: [entry], observedAt: tomorrow, confidence: 0.9 });
    await consolidateGeo(tx, a.objectId, { today: tomorrow });
    expect((await latestProfile(tx, a.objectId))?.attributes[attribute]).toEqual([entry]);
    // the next prompt switch: the re-mention stops counting
    await tx.execute(sql`update extraction_runs set prompt_version = prompt_version - 1 where id = ${r2}`);
    await consolidateGeo(tx, a.objectId, { today: tomorrow });
    return a;
  }

  it("prohibitions: the re-named ban stays, marked in_review, with a task", async () => {
    await withRollback(async (tx) => {
      const a = await removedThenRenamed(tx, "prohibitions", ban, 19.761, 34.661);
      const p = await latestProfile(tx, a.objectId);
      expect(p?.attributes["prohibitions"]).toEqual([ban]);
      expect(p?.provenance["prohibitions"]?.entryMarkers).toEqual({ anchoring: "in_review" });
      const task = await openTask(tx, a.objectId, "prohibitions");
      expect(task).toMatchObject({ priority: 2, context: { oldValue: [ban], newValue: [] } });
      // discarding the new proposal holds: the ban stays without the marker and no further task opens
      await decideReviewTask(tx, { taskId: task!.id, decision: { action: "discard_change" }, decidedBy: "test", taskKey: (task!.context as { key: string }).key });
      await consolidateGeo(tx, a.objectId, { today: tomorrow });
      const p2 = await latestProfile(tx, a.objectId);
      expect(p2?.attributes["prohibitions"]).toEqual([ban]);
      expect(p2?.provenance["prohibitions"]?.entryMarkers).toBeUndefined();
      expect(await openTask(tx, a.objectId, "prohibitions")).toBeUndefined();
    });
  });

  it("hazards (a union list): the re-named hazard stays, marked in_review, with a task", async () => {
    await withRollback(async (tx) => {
      const a = await removedThenRenamed(tx, "hazards", rock, 19.762, 34.662);
      const p = await latestProfile(tx, a.objectId);
      expect(p?.attributes["hazards"]).toEqual([rock]);
      expect(Object.values(p?.provenance["hazards"]?.entryMarkers ?? {})).toEqual(["in_review"]);
      expect(await openTask(tx, a.objectId, "hazards")).toMatchObject({ priority: 2, context: { oldValue: [rock], newValue: [] } });
    });
  });
});
