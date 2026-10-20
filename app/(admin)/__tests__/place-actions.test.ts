import { and, eq, isNotNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { facts, places, reviewDecisions } from "@/lib/db/schema";
import { GEOMETRY_CONSOLIDATION_STAGES } from "@/lib/pipeline/consolidation/stages";
import { testDb, withRollback } from "@/test/db";
import { seedDeliveryArea } from "@/test/fixtures/delivery/area";
import { buildBayScene } from "@/test/geometry/scene";
import { lonLatOf } from "@/test/geometry/synthetic";

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
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({}) }));
vi.mock("@/lib/pipeline/runs", () => ({ startRun: (...args: unknown[]) => startRun(...args) }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path), refresh: vi.fn() }));
const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import { mergePlaceAction, recomputeGeoProfileAction, recomputePlaceProfileAction, setAnchorAction } from "../places/[id]/actions";

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
          stages: ["geometry.place", ...GEOMETRY_CONSOLIDATION_STAGES],
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
        stages: ["consolidation.geo", "consolidation.summary", "consolidation.followup"],
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
      const f = await seedDeliveryArea(tx);
      const { A, M } = f.places;
      await mergePlaceAction(form({ placeId: A.placeId, intoPlaceId: M.placeId }));
      const [a] = await tx.select().from(places).where(eq(places.id, A.placeId));
      expect(a).toMatchObject({ status: "rejected", mergedIntoId: M.placeId });
      expect(startRun).toHaveBeenCalledTimes(1);
      expect(startRun.mock.calls[0]![2]).toMatchObject({ kind: "stage", params: { geoObjectIds: [M.geoObjectId] }, triggeredBy: ADMIN });
      expect(redirect).toHaveBeenCalledWith(`/places/${M.placeId}?merged=${A.placeId}&run=run-1`);
    }));

  it("a refusal returns to the place with the reason; the checkbox confirms a merge across areas", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const f = await seedDeliveryArea(tx);
      const { A, O, K } = f.places;
      await mergePlaceAction(form({ placeId: A.placeId, intoPlaceId: O.placeId }));
      expect(redirect).toHaveBeenLastCalledWith(`/places/${A.placeId}?mergeError=across_areas`);
      await mergePlaceAction(form({ placeId: A.placeId, intoPlaceId: K.placeId }));
      expect(redirect).toHaveBeenLastCalledWith(`/places/${A.placeId}?mergeError=not_valid`);
      await mergePlaceAction(form({ placeId: A.placeId, intoPlaceId: A.placeId }));
      expect(redirect).toHaveBeenLastCalledWith(`/places/${A.placeId}?mergeError=self`);
      expect(startRun).not.toHaveBeenCalled();
      await expect(mergePlaceAction(form({ placeId: A.placeId, intoPlaceId: "x" }))).rejects.toThrow();

      await mergePlaceAction(form({ placeId: A.placeId, intoPlaceId: O.placeId, confirmAcrossAreas: "on" }));
      expect(redirect).toHaveBeenLastCalledWith(expect.stringMatching(new RegExp(`^/places/${O.placeId}\\?merged=${A.placeId}`)));
    }));

  it("the merge stands when the follow-up run does not start", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const f = await seedDeliveryArea(tx);
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
