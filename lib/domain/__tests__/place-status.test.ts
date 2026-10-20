import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { SpotsFile } from "@/contract";
import type { Db } from "@/lib/db/client";
import { places, reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { PlaceStatusNotAllowed, setPlaceStatusByAdmin } from "@/lib/domain/place-status";
import { createReviewTask } from "@/lib/domain/review";
import { withRollback } from "@/test/db";
import { seedDeliveryArea } from "@/test/fixtures/delivery/area";
import { memoryArchive } from "@/test/s3";

/* „Bestätigen“ / „Verwerfen“ / „Kein Ankerplatz“ in the place header (gesamt review UI-3), on the delivery fixture. */

const ADMIN = "admin@test.invalid";

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PlaceStatusNotAllowed) return e.reason;
    throw e;
  }
  return "set";
};

const placeRow = async (tx: Db, id: string) => (await tx.select().from(places).where(eq(places.id, id)))[0]!;

describe("setPlaceStatusByAdmin", () => {
  it("takes a confirmed place back as „Kein Ankerplatz“, recorded as a decided task with one decision", () =>
    withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const { A } = f.places;
      const result = await setPlaceStatusByAdmin(tx, { placeId: A.placeId, status: "no_anchoring", decidedBy: ADMIN });
      expect(result).toEqual({ geoObjectId: A.geoObjectId, previous: "confirmed" });
      expect(await placeRow(tx, A.placeId)).toMatchObject({ status: "no_anchoring", statusReason: "review", publicId: A.publicId });

      const [audit] = await tx
        .select({ task: reviewTasks, decision: reviewDecisions })
        .from(reviewTasks)
        .innerJoin(reviewDecisions, eq(reviewDecisions.taskId, reviewTasks.id))
        .where(and(eq(reviewTasks.subjectType, "place_status"), eq(reviewTasks.subjectId, A.placeId)));
      expect(audit!.task).toMatchObject({ kind: "place_candidate", status: "decided", context: { previous: "confirmed" } });
      expect(audit!.decision).toMatchObject({ decision: { action: "no_anchoring" }, decidedBy: ADMIN });
    }));

  it("confirms a candidate with a new public id; rejects a confirmed place", () =>
    withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const { K, M } = f.places;
      await setPlaceStatusByAdmin(tx, { placeId: K.placeId, status: "confirmed", decidedBy: ADMIN });
      const k = await placeRow(tx, K.placeId);
      expect(k).toMatchObject({ status: "confirmed", statusReason: null });
      expect(k.publicId).toMatch(/^sp_/);
      await setPlaceStatusByAdmin(tx, { placeId: M.placeId, status: "rejected", decidedBy: ADMIN });
      expect(await placeRow(tx, M.placeId)).toMatchObject({ status: "rejected", statusReason: "review" });
    }));

  it("refuses while the place has an open task, for the status it has, and for a merged place; nothing is written", () =>
    withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const { A, M, B } = f.places;
      await createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId: A.placeId, context: { reason: "restricted" } });
      expect(await refusal(setPlaceStatusByAdmin(tx, { placeId: A.placeId, status: "rejected", decidedBy: ADMIN }))).toBe("open_task");
      expect(await refusal(setPlaceStatusByAdmin(tx, { placeId: M.placeId, status: "confirmed", decidedBy: ADMIN }))).toBe("unchanged");
      await tx.update(places).set({ mergedIntoId: M.placeId, status: "rejected" }).where(eq(places.id, B.placeId));
      expect(await refusal(setPlaceStatusByAdmin(tx, { placeId: B.placeId, status: "confirmed", decidedBy: ADMIN }))).toBe("not_valid");
      expect((await placeRow(tx, A.placeId)).status).toBe("confirmed");
      const written = await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectType, "place_status"));
      expect(written.filter((t) => [A.placeId, M.placeId, B.placeId].includes(t.subjectId))).toEqual([]);
    }));

  it("the next package delivers a place taken back as „Kein Ankerplatz“ as excluded, and a rejected one no more", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      const build = (date: string) => buildDelivery(tx, archive, f.areaId, { now: new Date(`${date}T08:00:00Z`), inCallerTransaction: true });
      expect(await build("2040-06-01")).toMatchObject({ status: "valid", dataVersion: 1 });
      await setPlaceStatusByAdmin(tx, { placeId: f.places.A.placeId, status: "no_anchoring", decidedBy: ADMIN });
      await setPlaceStatusByAdmin(tx, { placeId: f.places.M.placeId, status: "rejected", decidedBy: ADMIN });
      expect(await build("2040-06-02")).toMatchObject({ status: "valid", dataVersion: 2 });
      const spots = JSON.parse(new TextDecoder().decode((await archive.get(`deliveries/${f.areaPublicId}/2/spots.json`))!)) as SpotsFile;
      expect(spots.spots.find((s) => s.id === f.places.A.publicId)).toMatchObject({ exclude: { excluded: true } });
      expect(spots.spots.find((s) => s.id === f.places.M.publicId)).toBeUndefined();
    }));
});
