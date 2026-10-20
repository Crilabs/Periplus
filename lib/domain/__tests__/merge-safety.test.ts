import { eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geoObjects, places, reviewTasks } from "@/lib/db/schema";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { mergeGeoObjects } from "@/lib/domain/gazetteer/merge";
import { createReviewTask } from "@/lib/domain/review";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { latestProfile } from "@/lib/domain/timeline";
import { insertPlace, insertProfileTask, insertSource, insertTextFact } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";

/*
 * Merges keep safety values (GR-3, GR-4; SAF-3, SAF-4): „Einem Ort zuordnen“ merges the geo objects like „Derselbe Ort“,
 * so the merged place's facts follow the merge chain; the stricter place status wins. Synthetic places at 19.71–19.74° E
 * (this file only), every row in withRollback.
 */

let today = "";
beforeAll(async () => {
  const { rows } = await testDb().execute<{ today: string }>(sql`select current_date::text as today`);
  today = rows[0]!.today;
});

const ban = { kind: "anchoring", months: null };
const rock = { kind: "rock", name: null };

async function statusOf(tx: Db, placeId: string) {
  const [p] = await tx.select({ status: places.status, statusReason: places.statusReason, mergedIntoId: places.mergedIntoId }).from(places).where(eq(places.id, placeId));
  return p!;
}

describe("„Einem Ort zuordnen“ merges the geo objects (GR-3, SAF-3)", () => {
  it("the merged place's bans and hazards reach the target's profile", async () => {
    await withRollback(async (tx) => {
      const a = await insertPlace(tx, { lon: 19.711, lat: 34.611, name: "Alpha", status: "candidate" });
      const b = await insertPlace(tx, { lon: 19.7111, lat: 34.6111, name: "Beta", status: "confirmed" });
      const src = await insertSource(tx);
      await insertTextFact(tx, a.objectId, src, { attribute: "prohibitions", value: [ban], confidence: 0.9 });
      await insertTextFact(tx, a.objectId, src, { attribute: "hazards", value: [rock], confidence: 0.9 });
      const { taskId: openProfileTask } = await insertProfileTask(tx, a.objectId, { kind: "uncertain_change", attribute: "hazards", key: "k-hazards", status: "open" });
      const task = await createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId: a.placeId, context: {} });
      const res = await decideReviewTask(tx, { taskId: task.id, decision: { action: "merge", intoPlaceId: b.placeId }, decidedBy: "test" });
      expect(res.consolidate).toEqual({ geoObjectId: b.objectId });
      const objects = await tx.select({ id: geoObjects.id, mergedIntoId: geoObjects.mergedIntoId }).from(geoObjects).where(inArray(geoObjects.id, [a.objectId, b.objectId]));
      expect(objects.find((o) => o.id === a.objectId)?.mergedIntoId).toBe(b.objectId);
      expect(await statusOf(tx, a.placeId)).toMatchObject({ status: "rejected", statusReason: "merged", mergedIntoId: b.placeId });
      // the merged object's open profile task ends with it
      const [t] = await tx.select({ status: reviewTasks.status, context: reviewTasks.context }).from(reviewTasks).where(eq(reviewTasks.id, openProfileTask));
      expect(t).toMatchObject({ status: "dismissed", context: { dismissedReason: "object_ended" } });

      await consolidateGeo(tx, b.objectId, { today });
      const p = await latestProfile(tx, b.objectId);
      expect(p?.attributes["prohibitions"]).toEqual([ban]);
      expect(p?.attributes["hazards"]).toEqual([rock]);
    });
  });

  it("an excluded place merged into a confirmed one makes the target excluded", async () => {
    await withRollback(async (tx) => {
      const a = await insertPlace(tx, { lon: 19.712, lat: 34.612, name: "Gamma", status: "no_anchoring" });
      await tx.update(places).set({ statusReason: "review" }).where(eq(places.id, a.placeId));
      const b = await insertPlace(tx, { lon: 19.7121, lat: 34.6121, name: "Delta", status: "confirmed" });
      const task = await createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId: a.placeId, context: {} });
      await decideReviewTask(tx, { taskId: task.id, decision: { action: "merge", intoPlaceId: b.placeId }, decidedBy: "test" });
      expect(await statusOf(tx, b.placeId)).toMatchObject({ status: "no_anchoring", statusReason: "review" });
    });
  });
});

describe("merging keeps the stricter status (GR-4, SAF-4)", () => {
  it("„Derselbe Ort“ with an excluded drop place leaves an excluded survivor, with the drop's reason", async () => {
    await withRollback(async (tx) => {
      const keep = await insertPlace(tx, { lon: 19.74, lat: 34.64, name: "Epsilon", status: "confirmed" });
      const drop = await insertPlace(tx, { lon: 19.7401, lat: 34.6401, name: "Epsilon Bay", status: "no_anchoring" });
      await tx.update(places).set({ statusReason: "restricted:military:x" }).where(eq(places.id, drop.placeId));
      await mergeGeoObjects(tx, keep.objectId, drop.objectId);
      expect(await statusOf(tx, keep.placeId)).toMatchObject({ status: "no_anchoring", statusReason: "restricted:military:x", mergedIntoId: null });
      expect(await statusOf(tx, drop.placeId)).toMatchObject({ status: "rejected", statusReason: "merged", mergedIntoId: keep.placeId });
    });
  });

  it("an excluded survivor stays excluded when a confirmed place is merged into it", async () => {
    await withRollback(async (tx) => {
      const keep = await insertPlace(tx, { lon: 19.741, lat: 34.641, name: "Zeta", status: "no_anchoring" });
      await tx.update(places).set({ statusReason: "review" }).where(eq(places.id, keep.placeId));
      const drop = await insertPlace(tx, { lon: 19.7411, lat: 34.6411, name: "Zeta Bay", status: "confirmed" });
      await mergeGeoObjects(tx, keep.objectId, drop.objectId);
      expect(await statusOf(tx, keep.placeId)).toMatchObject({ status: "no_anchoring", statusReason: "review" });
    });
  });

  it("the „same“ decision on a geo object pair returns the survivor to consolidate", async () => {
    await withRollback(async (tx) => {
      const a = await insertPlace(tx, { lon: 19.742, lat: 34.642, name: "Eta", status: "confirmed" });
      const b = await insertPlace(tx, { lon: 19.7421, lat: 34.6421, name: "Eta Bay", status: "no_anchoring" });
      const [first, second] = [a.objectId, b.objectId].sort();
      const task = await createReviewTask(tx, { kind: "place_candidate", subjectType: "geo_object_pair", subjectId: `${first}:${second}`, context: {} });
      const res = await decideReviewTask(tx, { taskId: task.id, decision: { action: "same" }, decidedBy: "test" });
      expect(res.consolidate).toEqual({ geoObjectId: first });
      const survivor = first === a.objectId ? a : b;
      expect((await statusOf(tx, survivor.placeId)).status).toBe("no_anchoring");
    });
  });
});
