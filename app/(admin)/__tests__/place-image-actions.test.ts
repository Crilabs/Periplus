import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { placeImages } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { sql } from "drizzle-orm";
import { testDb, withRollback } from "@/test/db";
import { insertImageSubdivision, insertSpot } from "@/test/images";

const db = testDb();
let currentDb: Db = db;
const requireAdmin = vi.fn();
const startImageRun = vi.fn();
const redirect = vi.fn();

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db/client")>()), getDb: () => currentDb }));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({}) }));
vi.mock("@/lib/pipeline/images-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pipeline/images-run")>()),
  startImageRun: (...args: unknown[]) => startImageRun(...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

const { addPlaceViewAction, removePlaceImageAction } = await import("../places/[id]/actions");
const { startSubdivisionImagesAction } = await import("../subdivisions/actions");

beforeEach(() => {
  requireAdmin.mockReset().mockResolvedValue({ email: "admin@example.invalid" });
  startImageRun.mockReset().mockResolvedValue({ id: "run-1" });
  redirect.mockReset();
});

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function image(tx: Db, geoObjectId: string, slot: string) {
  const id = newId();
  await tx.execute(sql`
    insert into place_images (id, geo_object_id, kind, slot, file_key, width, height, alt, generation_key, camera_position, camera_height_m, view_bearing_deg, camera_tilt_deg, camera_fov_deg)
    values (${id}, ${geoObjectId}, 'ai_illustration', ${slot}, ${`images/places/${geoObjectId}/${id}.jpg`}, 10, 10, 'KI-Illustration: x', ${`g-${id}`}, ST_SetSRID(ST_MakePoint(19.37, 36.6), 4326), 260, 0, 30, 50)`);
  return id;
}

describe("addPlaceViewAction", () => {
  it("starts an image run for the next view slot with zoom and bearing, and goes to the run", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      await image(tx, spot.objectId, "title");
      await addPlaceViewAction(form({ placeId: spot.placeId, zoom: "z2", azimuthDeg: "135" }));
      expect(startImageRun).toHaveBeenCalledWith(tx, {}, { geoObjectId: spot.objectId, view: { slot: "view-2", zoom: "z2", azimuthDeg: 135 } }, "admin@example.invalid");
      expect(redirect).toHaveBeenCalledWith("/runs/run-1");
    }));

  it("leaves the bearing out when the field is empty", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      await addPlaceViewAction(form({ placeId: spot.placeId, zoom: "z1", azimuthDeg: "" }));
      expect(startImageRun.mock.calls[0]![2]).toEqual({ geoObjectId: spot.objectId, view: { slot: "view-2", zoom: "z1" } });
    }));

  it("refuses a bearing outside 0-359 and a zoom the imagery does not support", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      await expect(addPlaceViewAction(form({ placeId: spot.placeId, zoom: "z1", azimuthDeg: "360" }))).rejects.toThrow();
      expect(startImageRun).not.toHaveBeenCalled();
      // a coarse core tile allows z1 only
      await tx.execute(sql`
        insert into imagery_tiles (id, source, tile_key, bbox, resolution_m, license, attribution, file_key, bytes)
        values (${newId()}, 'ktimatologio', ${`t-${newId()}`}, ST_MakeEnvelope(19.36, 36.6, 19.38, 36.62, 4326), 12, 'x', 'x', 'k', 1)`);
      await addPlaceViewAction(form({ placeId: spot.placeId, zoom: "z3" }));
      expect(startImageRun).not.toHaveBeenCalled();
      expect(redirect).toHaveBeenCalledWith(`/places/${spot.placeId}?tab=image&imageError=zoom`);
    }));

  it("returns a refused run to the tab with its reason", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      startImageRun.mockRejectedValue(new RunScopeNotReady("place_not_computable", "no place"));
      await addPlaceViewAction(form({ placeId: spot.placeId, zoom: "z1" }));
      expect(redirect).toHaveBeenCalledWith(`/places/${spot.placeId}?tab=image&error=place_not_computable`);
    }));
});

describe("removePlaceImageAction", () => {
  it("ends the posted image and a stale second post says the page changed", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const id = await image(tx, spot.objectId, "title");
      await removePlaceImageAction(form({ placeId: spot.placeId, imageId: id }));
      expect(redirect).toHaveBeenLastCalledWith(`/places/${spot.placeId}?tab=image&imageNotice=removed`);
      const current = await tx.select({ id: placeImages.id }).from(placeImages).where(and(eq(placeImages.geoObjectId, spot.objectId), isNull(placeImages.validTo)));
      expect(current).toEqual([]);
      await removePlaceImageAction(form({ placeId: spot.placeId, imageId: id }));
      expect(redirect).toHaveBeenLastCalledWith(`/places/${spot.placeId}?tab=image&imageNotice=changed`);
    }));
});

describe("startSubdivisionImagesAction", () => {
  it("starts the Landesteil's image run and goes to it", async () => {
    await startSubdivisionImagesAction(form({ subdivisionKey: "GR-X" }));
    expect(startImageRun).toHaveBeenCalledWith(currentDb, {}, { subdivisionKey: "GR-X" }, "admin@example.invalid");
    expect(redirect).toHaveBeenCalledWith("/runs/run-1");
  });
});
