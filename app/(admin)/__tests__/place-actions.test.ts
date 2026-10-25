import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { facts, geoObjects, places, reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { createReviewTask } from "@/lib/domain/review";
import { testDb, withRollback } from "@/test/db";
import { seedDeliverySubdivision as seedFixture } from "@/test/fixtures/delivery/subdivision";
import { buildBayScene } from "@/test/geometry/scene";
import { lonLatOf } from "@/test/geometry/synthetic";
import { insertTestSubdivision } from "@/test/text";

/** The delivery fixture with its places A, M, B, C and K on the land of one subdivision; O belongs to none (spec 14). */
async function seedDeliverySubdivision(tx: Db) {
  const f = await seedFixture(tx);
  const { id } = await insertTestSubdivision(tx, `XT-${newId()}`, [21.0, 35.0, 21.75, 35.25]);
  const { A, M, B, C, K } = f.places;
  await tx.update(geoObjects).set({ subdivisionId: id }).where(inArray(geoObjects.id, [A, M, B, C, K].map((p) => p.geoObjectId)));
  return f;
}

const db = testDb();
/** What getDb() returns; each test points it at its rollback transaction. */
let currentDb: Db = db;
const requireAdmin = vi.fn();
const startRun = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => currentDb,
}));
/** The job queue cannot be reached (getBoss throws), e.g. right after a decision committed. */
let bossDown = false;
vi.mock("@/lib/jobs/boss", () => ({
  getBoss: async () => {
    if (bossDown) throw new Error("queue down");
    return {};
  },
}));
vi.mock("@/lib/pipeline/runs", () => ({ startRun: (...args: unknown[]) => startRun(...args) }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path), refresh: vi.fn() }));
const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
/** Runs right after the merge's transaction, before the action goes on (a concurrent commit in that gap). */
let afterMerge: ((dropGeoObjectId: string) => Promise<void>) | null = null;
vi.mock("@/lib/domain/place-merge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain/place-merge")>();
  return {
    ...actual,
    mergePlaceInto: async (...args: Parameters<typeof actual.mergePlaceInto>) => {
      const merged = await actual.mergePlaceInto(...args);
      await afterMerge?.(merged.dropGeoObjectId);
      return merged;
    },
  };
});

import {
  mergePlaceAction,
  recomputeGeoProfileAction,
  recomputePlaceProfileAction,
  setAnchorAction,
  setPlaceStatusAction,
} from "../places/[id]/actions";

const ADMIN = "admin@example.invalid";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

async function reviewAnchorFacts(tx: Db, geoObjectId: string) {
  return tx
    .select({ value: facts.value, confidence: facts.confidence, decidedBy: reviewDecisions.decidedBy })
    .from(facts)
    .innerJoin(reviewDecisions, eq(reviewDecisions.id, facts.reviewDecisionId))
    .where(and(eq(facts.geoObjectId, geoObjectId), eq(facts.attribute, "anchor_position"), isNotNull(facts.reviewDecisionId)));
}

async function anchorOrigin(tx: Db, placeId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ anchor_origin: string | null }>(sql`select anchor_origin from places where id = ${placeId}`);
  return rows[0]!.anchor_origin;
}

beforeEach(() => {
  vi.resetAllMocks();
  bossDown = false;
  afterMerge = null;
  currentDb = db;
  requireAdmin.mockResolvedValue({ email: ADMIN });
  startRun.mockResolvedValue({ id: "run-1" });
});

describe("setAnchorAction", () => {
  it("rejects without admin session", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const scene = await buildBayScene(tx);
      const position = await lonLatOf(tx, 0, 150);
      requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
      await expect(setAnchorAction({ placeId: scene.placeId, ...position })).rejects.toThrow("NEXT_REDIRECT");
      expect(await reviewAnchorFacts(tx, scene.geoObjectId)).toEqual([]);
      expect(startRun).not.toHaveBeenCalled();
    }));

  it("rejects lat 91", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const scene = await buildBayScene(tx);
      await expect(setAnchorAction({ placeId: scene.placeId, lon: 21, lat: 91 })).rejects.toThrow();
      await expect(setAnchorAction(form({ placeId: scene.placeId, lon: "181", lat: "35" }))).rejects.toThrow();
      await expect(setAnchorAction({ placeId: "not-a-uuid", lon: 21, lat: 35 })).rejects.toThrow();
      expect(await reviewAnchorFacts(tx, scene.geoObjectId)).toEqual([]);
      expect(startRun).not.toHaveBeenCalled();
    }));

  it("sets the anchor and writes a review fact", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const scene = await buildBayScene(tx);
      const position = await lonLatOf(tx, 0, 150);
      const result = await setAnchorAction(
        form({ placeId: scene.placeId, lon: String(position.lon), lat: String(position.lat) }),
      );
      expect(result).toEqual({ ok: true, runId: "run-1", message: "Ankerposition übernommen, Geometrie wird neu berechnet." });
      expect(await reviewAnchorFacts(tx, scene.geoObjectId)).toEqual([
        { value: position, confidence: 0.9, decidedBy: ADMIN },
      ]);
      expect(await anchorOrigin(tx, scene.placeId)).toBe("review");
      // A single-place geometry run follows the correction.
      expect(startRun).toHaveBeenCalledWith(
        tx,
        expect.anything(),
        expect.objectContaining({
          kind: "stage",
          scope: { type: "place", id: scene.placeId },
          stages: ["geometry.place"],
          params: { placeIds: [scene.placeId] },
          triggeredBy: ADMIN,
        }),
      );
      expect(revalidatePath).toHaveBeenCalledWith(`/places/${scene.placeId}`);
    }));

  it("keeps the anchor and says why when the geometry run cannot start", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const scene = await buildBayScene(tx, { raster: false });
      const position = await lonLatOf(tx, 0, 150);
      const result = await setAnchorAction({ placeId: scene.placeId, ...position });
      expect(result).toEqual({
        ok: true,
        runId: null,
        message: "Ankerposition übernommen. Geometrie nicht neu berechnet: Bathymetrie fehlt – zuerst „Datensätze laden“.",
      });
      expect(await reviewAnchorFacts(tx, scene.geoObjectId)).toHaveLength(1);
      expect(startRun).not.toHaveBeenCalled();
    }));

  it("keeps the anchor and says so when the job queue is down after the commit, instead of an error page (UI-7)", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const scene = await buildBayScene(tx);
      const position = await lonLatOf(tx, 0, 150);
      bossDown = true;
      const result = await setAnchorAction({ placeId: scene.placeId, ...position });
      expect(result).toEqual({
        ok: true,
        runId: null,
        message: "Ankerposition übernommen. Die Neuberechnung der Geometrie konnte nicht gestartet werden – bitte im Reiter „Geometrie“ erneut starten.",
      });
      expect(await reviewAnchorFacts(tx, scene.geoObjectId)).toHaveLength(1);
    }));

  it("too far → German error message", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const scene = await buildBayScene(tx);
      const far = await lonLatOf(tx, 0, 2600);
      const result = await setAnchorAction({ placeId: scene.placeId, ...far });
      expect(result).toEqual({ ok: false, error: "Ankerposition zu weit vom Ort entfernt (max. 2 km)" });
      expect(await reviewAnchorFacts(tx, scene.geoObjectId)).toEqual([]);
      expect(await anchorOrigin(tx, scene.placeId)).not.toBe("review");
      expect(startRun).not.toHaveBeenCalled();
    }));
});

describe("„Profil neu berechnen“", () => {
  it("the place action starts a place-scoped consolidation run and goes to it", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const scene = await buildBayScene(tx);
      await recomputePlaceProfileAction(form({ placeId: scene.placeId }));
      expect(startRun).toHaveBeenCalledTimes(1);
      expect(startRun.mock.calls[0]![2]).toMatchObject({
        kind: "stage",
        scope: { type: "place", id: scene.placeId },
        stages: ["consolidation.geo", "consolidation.highlights", "consolidation.summary", "consolidation.followup", "images.place"],
        params: { geoObjectIds: [scene.geoObjectId] },
        triggeredBy: ADMIN,
      });
      expect(redirect).toHaveBeenCalledWith("/runs/run-1");
    }));

  it("the geo action starts a run for the object; an object without facts returns with the reason", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const scene = await buildBayScene(tx);
      await recomputeGeoProfileAction({ geoObjectId: scene.geoObjectId });
      expect(startRun.mock.calls[0]![2]).toMatchObject({ scope: { type: "place", id: scene.placeId }, params: { geoObjectIds: [scene.geoObjectId] } });
      await recomputeGeoProfileAction({ geoObjectId: "01a1556d-0000-7000-8000-000000000000" });
      expect(redirect).toHaveBeenLastCalledWith("/geo/01a1556d-0000-7000-8000-000000000000?error=geo_object_not_consolidatable");
      expect(startRun).toHaveBeenCalledTimes(1);
    }));

  it("rejects without admin session", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const scene = await buildBayScene(tx);
      requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
      await expect(recomputePlaceProfileAction({ placeId: scene.placeId })).rejects.toThrow("NEXT_REDIRECT");
      await expect(recomputeGeoProfileAction({ geoObjectId: scene.geoObjectId })).rejects.toThrow("NEXT_REDIRECT");
      expect(startRun).not.toHaveBeenCalled();
    }));
});

describe("„Mit Ort zusammenlegen“", () => {
  it("merges, then starts the consolidation of the surviving object after the commit and goes to it", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const f = await seedDeliverySubdivision(tx);
      const { A, M } = f.places;
      await mergePlaceAction(form({ placeId: A.placeId, intoPlaceId: M.placeId }));
      const [a] = await tx.select().from(places).where(eq(places.id, A.placeId));
      expect(a).toMatchObject({ status: "rejected", mergedIntoId: M.placeId });
      expect(startRun).toHaveBeenCalledTimes(1);
      expect(startRun.mock.calls[0]![2]).toMatchObject({ kind: "stage", params: { geoObjectIds: [M.geoObjectId] }, triggeredBy: ADMIN });
      expect(redirect).toHaveBeenCalledWith(`/places/${M.placeId}?merged=${A.placeId}&run=run-1`);
    }));

  it("dismisses a task a consolidation of the merged object opened after the merge locked its tasks (review minor 1)", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const f = await seedDeliverySubdivision(tx);
      const { A, M } = f.places;
      let late: string | undefined;
      afterMerge = async (dropGeoObjectId) => {
        late = (await createReviewTask(tx, { kind: "conflict", subjectType: "profile_attribute", subjectId: `${dropGeoObjectId}:holding`, context: { key: "holding:k" } })).id;
      };
      await mergePlaceAction(form({ placeId: A.placeId, intoPlaceId: M.placeId }));
      expect(late).toBeDefined();
      const [task] = await tx.select().from(reviewTasks).where(eq(reviewTasks.id, late!));
      expect(task).toMatchObject({ status: "dismissed", context: expect.objectContaining({ dismissedReason: "object_ended" }) });
      expect(redirect).toHaveBeenCalledWith(`/places/${M.placeId}?merged=${A.placeId}&run=run-1`);
    }));

  it("a refusal returns to the place with the reason; the checkbox confirms a merge across subdivisions", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const f = await seedDeliverySubdivision(tx);
      const { A, O, K } = f.places;
      await mergePlaceAction(form({ placeId: A.placeId, intoPlaceId: O.placeId }));
      expect(redirect).toHaveBeenLastCalledWith(`/places/${A.placeId}?mergeError=across_subdivisions`);
      await mergePlaceAction(form({ placeId: A.placeId, intoPlaceId: K.placeId }));
      expect(redirect).toHaveBeenLastCalledWith(`/places/${A.placeId}?mergeError=not_valid`);
      await mergePlaceAction(form({ placeId: A.placeId, intoPlaceId: A.placeId }));
      expect(redirect).toHaveBeenLastCalledWith(`/places/${A.placeId}?mergeError=self`);
      expect(startRun).not.toHaveBeenCalled();
      await expect(mergePlaceAction(form({ placeId: A.placeId, intoPlaceId: "x" }))).rejects.toThrow();

      await mergePlaceAction(form({ placeId: A.placeId, intoPlaceId: O.placeId, confirmAcrossSubdivisions: "on" }));
      expect(redirect).toHaveBeenLastCalledWith(expect.stringMatching(new RegExp(`^/places/${O.placeId}\\?merged=${A.placeId}`)));
    }));

  it("the merge stands when the follow-up run does not start", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const f = await seedDeliverySubdivision(tx);
      startRun.mockRejectedValue(new Error("queue down"));
      await mergePlaceAction({ placeId: f.places.A.placeId, intoPlaceId: f.places.M.placeId });
      expect(redirect).toHaveBeenCalledWith(`/places/${f.places.M.placeId}?merged=${f.places.A.placeId}&mergedNoRun=1`);
      const [a] = await tx.select().from(places).where(eq(places.id, f.places.A.placeId));
      expect(a!.mergedIntoId).toBe(f.places.M.placeId);
    }));

  it("rejects without admin session", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(mergePlaceAction({ placeId: "0199f0a0-0000-7000-8000-000000000001", intoPlaceId: "0199f0a0-0000-7000-8000-000000000002" })).rejects.toThrow("NEXT_REDIRECT");
    expect(startRun).not.toHaveBeenCalled();
  });
});

describe("„Bestätigen“ / „Verwerfen“ / „Kein Ankerplatz“ in the place header (UI-3)", () => {
  it("sets the status, then starts the consolidation of the place's object after the commit", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const f = await seedDeliverySubdivision(tx);
      const { A } = f.places;
      await setPlaceStatusAction(form({ placeId: A.placeId, status: "no_anchoring", from: "confirmed" }));
      const [a] = await tx.select().from(places).where(eq(places.id, A.placeId));
      expect(a).toMatchObject({ status: "no_anchoring", statusReason: "review" });
      expect(startRun).toHaveBeenCalledTimes(1);
      expect(startRun.mock.calls[0]![2]).toMatchObject({ kind: "stage", params: { geoObjectIds: [A.geoObjectId] }, triggeredBy: ADMIN });
      expect(redirect).toHaveBeenCalledWith(`/places/${A.placeId}?status=no_anchoring&run=run-1`);
    }));

  it("the status stands when the follow-up run does not start; a refusal returns with the reason", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const f = await seedDeliverySubdivision(tx);
      startRun.mockRejectedValue(new Error("queue down"));
      await setPlaceStatusAction({ placeId: f.places.M.placeId, status: "rejected", from: "confirmed" });
      expect(redirect).toHaveBeenLastCalledWith(`/places/${f.places.M.placeId}?status=rejected&statusNoRun=1`);
      expect((await tx.select().from(places).where(eq(places.id, f.places.M.placeId)))[0]!.status).toBe("rejected");
      await setPlaceStatusAction({ placeId: f.places.M.placeId, status: "rejected", from: "rejected" });
      expect(redirect).toHaveBeenLastCalledWith(`/places/${f.places.M.placeId}?statusError=unchanged`);
      await expect(setPlaceStatusAction({ placeId: f.places.M.placeId, status: "abandoned" as "rejected", from: "rejected" })).rejects.toThrow();
      // without the shown status the form is invalid
      await expect(setPlaceStatusAction(form({ placeId: f.places.M.placeId, status: "confirmed" }))).rejects.toThrow();
    }));

  it("a stale tab (the status changed since the page showed it) returns with ?statusError=changed and writes nothing (W4-2)", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const f = await seedDeliverySubdivision(tx);
      const { K } = f.places;
      await setPlaceStatusAction(form({ placeId: K.placeId, status: "confirmed", from: "candidate" }));
      expect(redirect).toHaveBeenLastCalledWith(expect.stringMatching(new RegExp(`^/places/${K.placeId}\\?status=confirmed`)));
      startRun.mockClear();
      // tab A still shows K as a candidate and offers a plain „Verwerfen“
      await setPlaceStatusAction(form({ placeId: K.placeId, status: "rejected", from: "candidate" }));
      expect(redirect).toHaveBeenLastCalledWith(`/places/${K.placeId}?statusError=changed`);
      expect((await tx.select().from(places).where(eq(places.id, K.placeId)))[0]!.status).toBe("confirmed");
      expect(startRun).not.toHaveBeenCalled();
    }));

  it("rejects without admin session", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(setPlaceStatusAction({ placeId: "0199f0a0-0000-7000-8000-000000000001", status: "rejected", from: "confirmed" })).rejects.toThrow("NEXT_REDIRECT");
    expect(startRun).not.toHaveBeenCalled();
  });
});
