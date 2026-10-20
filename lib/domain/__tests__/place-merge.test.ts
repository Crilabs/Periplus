import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { SpotsFile } from "@/contract";
import type { Db } from "@/lib/db/client";
import { geoNames, geoObjects, places, reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { mergeCandidates, mergePlaceInto, PlaceMergeNotAllowed } from "@/lib/domain/place-merge";
import { createReviewTask } from "@/lib/domain/review";
import { testDb, withRollback } from "@/test/db";
import { seedDeliveryArea, type DeliveryFixture } from "@/test/fixtures/delivery/area";
import { memoryArchive } from "@/test/s3";

/*
 * „Mit Ort zusammenlegen“ (ruling M6-P15) on the delivery fixture (rolled back): A and M are confirmed spots of one
 * area, B and C confirmed too, K a candidate, O confirmed on a tile without area.
 */

const ADMIN = "admin@test.invalid";

const openTask = (tx: Db, kind: "conflict" | "uncertain_change", geoObjectId: string, attribute: string) =>
  createReviewTask(tx, { kind, subjectType: "profile_attribute", subjectId: `${geoObjectId}:${attribute}`, context: { key: `${attribute}:k`, geoObjectId } });

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PlaceMergeNotAllowed) return e.reason;
    throw e;
  }
  return "merged";
};

const placeRow = async (tx: Db, id: string) => (await tx.select().from(places).where(eq(places.id, id)))[0]!;
const geoRow = async (tx: Db, id: string) => (await tx.select().from(geoObjects).where(eq(geoObjects.id, id)))[0]!;

describe("mergePlaceInto", () => {
  it("merges a confirmed place into another: place and geo object merged, its open profile tasks dismissed, the decision recorded", () =>
    withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const { A, M } = f.places;
      const conflict = await openTask(tx, "conflict", A.geoObjectId, "holding");
      const uncertain = await openTask(tx, "uncertain_change", A.geoObjectId, "capacity");
      const keepTask = await openTask(tx, "conflict", M.geoObjectId, "holding");

      const result = await mergePlaceInto(tx, { placeId: A.placeId, intoPlaceId: M.placeId, decidedBy: ADMIN });
      expect(result).toEqual({ keepGeoObjectId: M.geoObjectId, dropGeoObjectId: A.geoObjectId, dismissedTaskIds: [conflict.id, uncertain.id].sort() });

      expect(await placeRow(tx, A.placeId)).toMatchObject({ status: "rejected", statusReason: "merged", mergedIntoId: M.placeId, publicId: A.publicId });
      expect(await placeRow(tx, M.placeId)).toMatchObject({ status: "confirmed", mergedIntoId: null });
      const drop = await geoRow(tx, A.geoObjectId);
      expect(drop.mergedIntoId).toBe(M.geoObjectId);
      expect(drop.validTo).not.toBeNull();
      // the gazetteer merge: A's names and OSM id go to M
      expect((await geoRow(tx, M.geoObjectId)).osmId).toBe((await geoRow(tx, A.geoObjectId)).osmId);
      const mNames = await tx.select({ name: geoNames.name }).from(geoNames).where(eq(geoNames.geoObjectId, M.geoObjectId));
      expect(mNames.map((n) => n.name)).toContain("Vathi Bay");

      const tasks = await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, `${A.geoObjectId}:holding`));
      expect(tasks).toEqual([expect.objectContaining({ status: "dismissed", context: expect.objectContaining({ dismissedReason: "object_ended" }) })]);
      expect((await tx.select().from(reviewTasks).where(eq(reviewTasks.id, uncertain.id)))[0]!.status).toBe("dismissed");
      // the surviving object's tasks stay open
      expect((await tx.select().from(reviewTasks).where(eq(reviewTasks.id, keepTask.id)))[0]!.status).toBe("open");

      const [audit] = await tx
        .select({ task: reviewTasks, decision: reviewDecisions })
        .from(reviewTasks)
        .innerJoin(reviewDecisions, eq(reviewDecisions.taskId, reviewTasks.id))
        .where(and(eq(reviewTasks.subjectType, "place_merge"), eq(reviewTasks.subjectId, A.placeId)));
      expect(audit!.task).toMatchObject({ kind: "place_candidate", status: "decided", context: expect.objectContaining({ intoPlaceId: M.placeId, acrossAreas: false }) });
      expect(audit!.decision).toMatchObject({ decision: { action: "merge_place", intoPlaceId: M.placeId }, decidedBy: ADMIN });
    }));

  it("refuses merging into itself, into a candidate, an ended or a merged place, and across areas without confirmation", () =>
    withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const { A, M, B, K, O, C } = f.places;
      const merge = (placeId: string, intoPlaceId: string, confirmAcrossAreas?: boolean) =>
        refusal(mergePlaceInto(tx, { placeId, intoPlaceId, decidedBy: ADMIN, confirmAcrossAreas }));
      expect(await merge(A.placeId, A.placeId)).toBe("self");
      expect(await merge(A.placeId, K.placeId)).toBe("not_valid");
      expect(await merge(K.placeId, A.placeId)).toBe("not_valid");
      // C is no_anchoring, not confirmed
      expect(await merge(A.placeId, C.placeId)).toBe("not_valid");
      expect(await merge(A.placeId, "0199f0a0-0000-7000-8000-00000000ffff")).toBe("not_valid");
      // O lies on a tile without area
      expect(await merge(A.placeId, O.placeId)).toBe("across_areas");
      // nothing was written by the refusals
      expect(await placeRow(tx, A.placeId)).toMatchObject({ status: "confirmed", mergedIntoId: null });
      expect(await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectType, "place_merge"))).toEqual([]);

      expect(await merge(B.placeId, M.placeId)).toBe("merged");
      // B is merged now: neither a source nor a target any more
      expect(await merge(B.placeId, A.placeId)).toBe("not_valid");
      expect(await merge(A.placeId, B.placeId)).toBe("not_valid");
      // an ended place
      await tx.update(places).set({ validTo: sql`current_date` }).where(eq(places.id, M.placeId));
      expect(await merge(A.placeId, M.placeId)).toBe("not_valid");
      // across areas with the confirmation
      expect(await merge(A.placeId, O.placeId, true)).toBe("merged");
      expect((await placeRow(tx, A.placeId)).mergedIntoId).toBe(O.placeId);
    }));
});

describe("mergePlaceInto and the profile lock", () => {
  it("never consolidates inside the merge: it completes while both profile locks are held elsewhere (ruling M5-F-R4)", () =>
    withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const { A, M } = f.places;
      // a merge that took a profile lock would wait and hit the lock timeout
      await tx.execute(sql`set local lock_timeout = '300ms'`);
      await holdingLocks(testDb(), [`profile:${M.geoObjectId}`, `profile:${A.geoObjectId}`], () =>
        mergePlaceInto(tx, { placeId: A.placeId, intoPlaceId: M.placeId, decidedBy: ADMIN }),
      );
      expect((await placeRow(tx, A.placeId)).mergedIntoId).toBe(M.placeId);
    }));
});

/** Holds the advisory locks `keys` in a transaction on another connection while `run` runs. */
async function holdingLocks<T>(db: Db, keys: string[], run: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holder = db.transaction(async (tx) => {
    for (const key of keys) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    locked();
    await held;
  });
  await isLocked;
  try {
    return await run();
  } finally {
    release();
    await holder;
  }
}

describe("mergeCandidates", () => {
  it("offers the nearest confirmed places with their area", () =>
    withRollback(async (tx) => {
      const f: DeliveryFixture = await seedDeliveryArea(tx);
      const { A, M, B, O, K, C } = f.places;
      const offered = await mergeCandidates(tx, A.placeId);
      const ids = offered.map((c) => c.id);
      expect(ids).toEqual(expect.arrayContaining([M.placeId, B.placeId, O.placeId]));
      expect(ids).not.toContain(A.placeId);
      expect(ids).not.toContain(K.placeId);
      expect(ids).not.toContain(C.placeId);
      // nearest first: B (5 km) before M (15 km) before O (42 km)
      expect(ids.indexOf(B.placeId)).toBeLessThan(ids.indexOf(M.placeId));
      expect(ids.indexOf(M.placeId)).toBeLessThan(ids.indexOf(O.placeId));
      expect(offered.find((c) => c.id === M.placeId)).toMatchObject({ name: "Marina Test", kind: "marina", publicId: M.publicId, sameArea: true, areaName: "Testrevier" });
      expect(offered.find((c) => c.id === O.placeId)).toMatchObject({ sameArea: false, areaName: null });
      expect(offered.find((c) => c.id === B.placeId)!.distanceM).toBeGreaterThan(1000);
    }));
});

describe("the next package after a merge", () => {
  it("delivers the merged spot with mergedInto the place it became part of", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      const build = (date: string) => buildDelivery(tx, archive, f.areaId, { now: new Date(`${date}T08:00:00Z`), inCallerTransaction: true });
      expect(await build("2040-06-01")).toMatchObject({ status: "valid", dataVersion: 1 });
      await mergePlaceInto(tx, { placeId: f.places.A.placeId, intoPlaceId: f.places.M.placeId, decidedBy: ADMIN });
      expect(await build("2040-06-02")).toMatchObject({ status: "valid", dataVersion: 2 });
      const spots = JSON.parse(new TextDecoder().decode((await archive.get(`deliveries/${f.areaPublicId}/2/spots.json`))!)) as SpotsFile;
      expect(spots.spots.find((s) => s.id === f.places.A.publicId)).toMatchObject({ mergedInto: f.places.M.publicId });
    }));
});
