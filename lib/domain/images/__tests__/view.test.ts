import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { imageryTiles, placeImages, placeRenders, type ImagerySource } from "@/lib/db/schema";
import { hasCoreImagery, imageCoverage, placeImageView } from "@/lib/domain/images/view";
import { newId } from "@/lib/domain/ids";
import { createReviewTask } from "@/lib/domain/review";
import { createRun } from "@/lib/domain/runs";
import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";
import { withRollback } from "@/test/db";
import { IMAGE_LAT, IMAGE_LON, insertImageSubdivision, insertSpot } from "@/test/images";

/*
 * The place's image view and the Landesteil coverage (spec 13, UI-Anteil). Spots lie around 19.37° E / 36.61° N.
 */

const cfg = getConfig();

async function tile(tx: Db, source: ImagerySource, o: { lon?: number; lat?: number; blank?: boolean; costEur?: string; resolutionM?: number } = {}) {
  const lon = o.lon ?? IMAGE_LON;
  const lat = o.lat ?? IMAGE_LAT;
  const id = newId();
  await tx.insert(imageryTiles).values({
    id,
    source,
    tileKey: `t-${id}`,
    bbox: geomFromGeoJson({ type: "Polygon", coordinates: [[[lon - 0.01, lat - 0.01], [lon + 0.01, lat - 0.01], [lon + 0.01, lat + 0.01], [lon - 0.01, lat + 0.01], [lon - 0.01, lat - 0.01]]] }),
    resolutionM: o.resolutionM ?? (source === "ktimatologio" ? 0.5 : 10),
    license: "test",
    attribution: `attribution ${source}`,
    fileKey: `imagery/tiles/${id}.jpg`,
    bytes: 1,
    blank: o.blank ?? false,
    costEur: o.costEur ?? "0",
  });
  return id;
}

/** A render of the spot built on `tileIds` (a run of its own). */
async function render(tx: Db, geoObjectId: string, tileIds: string[]) {
  const run = await createRun(tx, { kind: "stage", scope: { type: "system", id: "test" }, stages: [IMAGES_STAGE], triggeredBy: "test" });
  const id = newId();
  await tx.insert(placeRenders).values({
    id,
    geoObjectId,
    camera: { position: [IMAGE_LON, IMAGE_LAT - 0.01], heightM: 260, viewBearingDeg: 0, tiltDeg: 30, fovDeg: 50, target: [IMAGE_LON, IMAGE_LAT], azimuthDeg: 0, zoom: "z1" },
    zoom: "z1",
    imageryTileIds: tileIds,
    demTileIds: [],
    photoKey: `imagery/renders/${geoObjectId}/${id}/photo.png`,
    maskKey: `imagery/renders/${geoObjectId}/${id}/mask.png`,
    rendererVersion: "test",
    generationKey: `k-${id}`,
    runId: run.id,
  });
  return { id, photoKey: `imagery/renders/${geoObjectId}/${id}/photo.png`, maskKey: `imagery/renders/${geoObjectId}/${id}/mask.png` };
}

/** A current AI image of the spot (slot `title` unless given) from `renderId`. */
async function approvedImage(tx: Db, geoObjectId: string, renderId: string | null, o: { slot?: string; waterIou?: number; sortOrder?: number } = {}) {
  const id = newId();
  await tx.insert(placeImages).values({
    id,
    geoObjectId,
    kind: "ai_illustration",
    slot: o.slot ?? "title",
    sortOrder: o.sortOrder ?? 0,
    cameraPosition: sql`${geomFromGeoJson({ type: "Point", coordinates: [IMAGE_LON, IMAGE_LAT - 0.01] })}`,
    cameraHeightM: 260,
    viewBearingDeg: 0,
    cameraTiltDeg: 30,
    cameraFovDeg: 50,
    renderId,
    light: "midday",
    waterIou: o.waterIou ?? 0.9,
    fileKey: `images/places/${geoObjectId}/${id}.jpg`,
    width: 1536,
    height: 1024,
    alt: "KI-Illustration: Testbucht",
    generationKey: `g-${id}`,
    attribution: "Luftbild © Test",
    license: "periplus",
    observedAt: "2019-05-01",
  });
  return id;
}

async function decidedImageTask(tx: Db, geoObjectId: string, slot: string, action: "approve_image" | "no_image") {
  const task = await createReviewTask(tx, { kind: "place_image", subjectType: "place_image", subjectId: `${geoObjectId}:${slot}`, context: { key: `k-${newId()}` }, priority: 0 });
  await tx.execute(sql`insert into review_decisions (id, task_id, decision, decided_by) values (${newId()}, ${task.id}, ${JSON.stringify({ action })}::jsonb, 'test')`);
  await tx.execute(sql`update review_tasks set status = 'decided' where id = ${task.id}`);
}

describe("imageCoverage", () => {
  it("coverage counts spots, imagery, approved and deliverable separately", () =>
    withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const lon = (i: number) => IMAGE_LON + i * 0.05;
      const spots = [];
      for (let i = 0; i < 5; i++) spots.push(await insertSpot(tx, sd.id, { lon: lon(i) }));
      // 0: cadastre tile, approved image on it (blocked: ktimatologio is not delivered)
      const cadastre = [await tile(tx, "ktimatologio", { lon: lon(0), costEur: "0.4" }), await tile(tx, "ktimatologio", { lon: lon(1), costEur: "0.1" })];
      const r0 = await render(tx, spots[0]!.objectId, [cadastre[0]!]);
      await approvedImage(tx, spots[0]!.objectId, r0.id, { waterIou: 0.8 });
      // 1: cadastre tile, no image yet
      // 2: only satellite imagery: an approved image that is deliverable
      const sat = await tile(tx, "sentinel2", { lon: lon(2), costEur: "0.01" });
      const r2 = await render(tx, spots[2]!.objectId, [sat]);
      await approvedImage(tx, spots[2]!.objectId, r2.id, { waterIou: 0.6 });
      // 3: no imagery at all; 4: another status (not a spot)
      await tx.execute(sql`update places set status = 'candidate' where geo_object_id = ${spots[4]!.objectId}`);
      // review: 3 decided tasks, one of them „Kein Bild“
      await decidedImageTask(tx, spots[0]!.objectId, "title", "approve_image");
      await decidedImageTask(tx, spots[1]!.objectId, "title", "no_image");
      await decidedImageTask(tx, spots[2]!.objectId, "title", "approve_image");
      // costs: image edits are attributed to their place (`meta.geoObjectId`), whatever run made them: a consolidation run
      // over a tile, an image run of the subdivision. Calls of other services, of another object or without a place do not count.
      const tileRun = await createRun(tx, { kind: "stage", scope: { type: "tile", id: "T-1" }, stages: [IMAGES_STAGE], triggeredBy: "test" });
      const subRun = await createRun(tx, { kind: "stage", scope: { type: "subdivision", id: sd.key }, stages: [IMAGES_STAGE], triggeredBy: "test" });
      const other = await insertSpot(tx, (await insertImageSubdivision(tx)).id, { lon: lon(6) });
      const call = (runId: string, service: string, cost: string, meta: Record<string, unknown>) =>
        tx.execute(
          sql`insert into external_calls (id, service, operation, units, unit, cost_eur, run_id, meta) values (${newId()}, ${service}, 'images.edit', 1, 'image', ${cost}, ${runId}, ${JSON.stringify(meta)}::jsonb)`,
        );
      await call(tileRun.id, "openai", "0.2", { geoObjectId: spots[0]!.objectId, slot: "title" });
      await call(subRun.id, "openai", "0.25", { geoObjectId: spots[2]!.objectId, slot: "view-2" });
      await call(subRun.id, "openai", "0.5", { geoObjectId: other.objectId, slot: "title" });
      await call(subRun.id, "openai", "0.5", {});
      await call(subRun.id, "anthropic", "0.7", { geoObjectId: spots[0]!.objectId });

      const c = await imageCoverage(tx, sd.id);
      expect(c.spots).toBe(4);
      expect(c.withImagery).toBe(1 + 1); // spot 0 and 1 have a cadastre tile at their position; spot 2 only a satellite one
      expect(c.withApprovedImage).toBe(2);
      expect(c.deliverable).toBe(1);
      expect(c.medianWaterIoU).toBeCloseTo(0.7, 5);
      expect(c.rejectedShare).toBeCloseTo(1 / 3, 5);
      expect(c.imageryCostEur).toBeCloseTo(0.41, 5);
      expect(c.generationCostEur).toBeCloseTo(0.45, 5);
    }));

  it("blank core tile does not count as imagery", () =>
    withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const blankSpot = await insertSpot(tx, sd.id, { lon: IMAGE_LON });
      const okSpot = await insertSpot(tx, sd.id, { lon: IMAGE_LON + 0.1 });
      await tile(tx, "ktimatologio", { lon: IMAGE_LON, blank: true });
      await tile(tx, "ktimatologio", { lon: IMAGE_LON + 0.1 });
      const c = await imageCoverage(tx, sd.id);
      expect(c.spots).toBe(2);
      expect(c.withImagery).toBe(1);
      expect(blankSpot.objectId).not.toBe(okSpot.objectId);
    }));

  it("an empty Landesteil has no median and no rejected share", () =>
    withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      expect(await imageCoverage(tx, sd.id)).toEqual({
        spots: 0,
        withImagery: 0,
        withApprovedImage: 0,
        deliverable: 0,
        medianWaterIoU: null,
        rejectedShare: null,
        imageryCostEur: 0,
        generationCostEur: 0,
      });
    }));
});

describe("hasCoreImagery", () => {
  it("names the countries of a WMS source with an explicit country list, not those of the satellite source", () => {
    expect(hasCoreImagery("GR")).toBe(true);
    expect(hasCoreImagery("HR")).toBe(false);
    const sources = structuredClone(cfg.images.sources);
    sources.ktimatologio.countries = "*";
    expect(hasCoreImagery("GR", { sources })).toBe(false);
  });
});

describe("placeImageView", () => {
  it("view names the blocking source", () =>
    withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const cadastre = await tile(tx, "ktimatologio");
      const sat = await tile(tx, "sentinel2");
      const r = await render(tx, spot.objectId, [cadastre, sat]);
      await approvedImage(tx, spot.objectId, r.id);

      const view = await placeImageView(tx, spot.objectId);
      expect(cfg.images.delivery.ktimatologio).toBe(false);
      expect(view.deliverable).toBe(false);
      expect(view.blockedBy).toEqual(["ktimatologio"]);
      // the place the images belong to, as the tab's header shows it (name, ids, points, composition)
      expect(view.place).toMatchObject({ geoObjectId: spot.objectId, placeId: spot.placeId, name: "Kolona", kind: "anchorage", cove: null });
      expect(view.place!.centre.lon).toBeCloseTo(IMAGE_LON, 9);
      expect(view.current).toMatchObject({
        slot: "title",
        kind: "ai_illustration",
        light: "midday",
        alt: "KI-Illustration: Testbucht",
        attribution: "Luftbild © Test",
        observedAt: "2019-05-01",
        waterIoU: 0.9,
        camera: { heightM: 260, viewBearingDeg: 0, tiltDeg: 30, fovDeg: 50 },
        render: { photoKey: r.photoKey, maskKey: r.maskKey },
      });
      expect(view.latestRender).toMatchObject({ photoKey: r.photoKey, maskKey: r.maskKey });
      expect(view.zooms).toEqual(["z1", "z2", "z3"]);
    }));

  it("a blank tile blocks nothing and an image built on delivered sources is deliverable", () =>
    withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const r = await render(tx, spot.objectId, [await tile(tx, "ktimatologio", { blank: true }), await tile(tx, "sentinel2")]);
      await approvedImage(tx, spot.objectId, r.id);
      const view = await placeImageView(tx, spot.objectId);
      expect(view.blockedBy).toEqual([]);
      expect(view.deliverable).toBe(true);
    }));

  it("shows the open task's candidate as a draft, and every current image of the place", () =>
    withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const r = await render(tx, spot.objectId, [await tile(tx, "sentinel2")]);
      await approvedImage(tx, spot.objectId, r.id, { slot: "title" });
      await approvedImage(tx, spot.objectId, r.id, { slot: "view-2", sortOrder: 1 });
      const task = await createReviewTask(tx, {
        kind: "place_image",
        subjectType: "place_image",
        subjectId: `${spot.objectId}:view-3`,
        context: { key: "k", slot: "view-3", candidateKey: "imagery/candidates/x/y.jpg", waterIoU: 0.85, passed: true, light: "evening" },
        priority: 0,
      });
      const view = await placeImageView(tx, spot.objectId);
      expect(view.images.map((i) => i.slot)).toEqual(["title", "view-2"]);
      expect(view.candidate).toEqual({ taskId: task.id, slot: "view-3", candidateKey: "imagery/candidates/x/y.jpg", waterIoU: 0.85, passed: true, light: "evening" });
    }));

  it("allows the zoom levels the core resolution supports, all configured ones without a core tile", () =>
    withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      await tile(tx, "ktimatologio", { resolutionM: 0.5 });
      const view = await placeImageView(tx, spot.objectId);
      expect(view.zooms).toContain("z1");
      const coarse = await insertSpot(tx, sd.id, { lon: IMAGE_LON + 0.2 });
      await tile(tx, "ktimatologio", { lon: IMAGE_LON + 0.2, resolutionM: 12 });
      expect((await placeImageView(tx, coarse.objectId)).zooms).toEqual(["z1"]);
    }));

  it("is empty for a place without images", () =>
    withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const view = await placeImageView(tx, spot.objectId);
      expect(view).toMatchObject({ current: null, candidate: null, latestRender: null, deliverable: false, blockedBy: [], images: [] });
    }));
});
