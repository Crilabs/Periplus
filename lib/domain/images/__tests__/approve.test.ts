import { and, eq, isNull, sql } from "drizzle-orm";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import { placeImages, reviewTasks } from "@/lib/db/schema";
import { attributionFor } from "@/lib/domain/images/approve";
import { cameraLine, compassPoint, slotLabel } from "@/lib/domain/images/camera-label";
import { DecisionNotAllowed, decideReviewTask, TaskContextChanged, type ReviewDecision } from "@/lib/domain/review-decisions";
import { createRun } from "@/lib/domain/runs";
import { generatePlaceImage, type ImageView, type PlaceImageTaskContext } from "@/lib/pipeline/images/generate";
import { imageTargets } from "@/lib/pipeline/images/stage";
import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";
import { withRollback } from "@/test/db";
import { checker, GOOD, imageModel, imageTasksOf, insertImageSubdivision, insertSpot, stubRender, syntheticImageryTransport } from "@/test/images";
import { memoryArchive } from "@/test/s3";

/*
 * Review of a `place_image` task (spec 13): approval into `place_images`, „Kein Bild“ and „Neu erzeugen“. The tasks
 * come from `generatePlaceImage` with the stub renderer and synthetic imagery (cadastre, Sentinel-2, flat DEM).
 */

const cfg = getConfig();
const ADMIN = "admin@example.invalid";
const TITLE: ImageView = { slot: "title", zoom: "z1" };
const NOW = new Date("2026-10-21T10:00:00Z");

async function spot(tx: Db) {
  const sd = await insertImageSubdivision(tx);
  const s = await insertSpot(tx, sd.id);
  const run = await createRun(tx, { kind: "stage", scope: { type: "system", id: "test" }, stages: [IMAGES_STAGE], triggeredBy: "test" });
  return { ...s, runId: run.id };
}

type Spot = Awaited<ReturnType<typeof spot>>;

/** Generates `view` of the spot (a new key with `model`) and returns its open task. */
async function generated(tx: Db, s: Spot, archive: Archive, view: ImageView = TITLE, model?: string, force?: boolean) {
  const config = model
    ? { ...cfg, models: { ...cfg.models, imageTasks: { "generate-place-image": { ...cfg.models.imageTasks["generate-place-image"]!, model } } } }
    : undefined;
  const result = await generatePlaceImage(
    tx,
    { geoObjectId: s.objectId, view, runId: s.runId, force },
    { archive, transport: await syntheticImageryTransport(), imageModel: await imageModel(GOOD), model: checker(false), render: stubRender, config },
  );
  const [task] = await imageTasksOf(tx, `${s.objectId}:${view.slot}`);
  return { result, task: task as { id: string; context: PlaceImageTaskContext } | undefined };
}

const decide = (tx: Db, task: { id: string; context: PlaceImageTaskContext }, decision: ReviewDecision, archive: Archive, taskKey = task.context.key) =>
  decideReviewTask(tx, { taskId: task.id, decision, decidedBy: ADMIN, now: NOW, taskKey }, { archive });

const currentImages = (tx: Db, geoObjectId: string) =>
  tx
    .select()
    .from(placeImages)
    .where(and(eq(placeImages.geoObjectId, geoObjectId), isNull(placeImages.validTo)))
    .orderBy(placeImages.sortOrder);

describe("attributionFor", () => {
  it("names each used source once, core, wide and DEM in that order, then the credit; blank tiles are not used", () => {
    const images = cfg.images;
    const text = attributionFor(
      [
        { source: "copernicus_dem", blank: false },
        { source: "sentinel2", blank: false },
        { source: "ktimatologio", blank: false },
        { source: "ktimatologio", blank: false },
      ],
      images,
    );
    expect(text).toBe(
      [images.sources.ktimatologio.attribution, images.sources.sentinel2.attribution, images.sources.copernicus_dem.attribution, images.output.credit].join(" · "),
    );
    expect(attributionFor([{ source: "ktimatologio", blank: true }, { source: "sentinel2", blank: false }], images)).toBe(
      `${images.sources.sentinel2.attribution} · ${images.output.credit}`,
    );
  });
});

describe("camera labels", () => {
  it("formats the camera line, the compass point and the slot in German", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(44)).toBe("NO");
    expect(compassPoint(135)).toBe("SO");
    expect(compassPoint(359)).toBe("N");
    // looking north: the camera stands south of the place
    expect(cameraLine({ viewBearingDeg: 0.4, heightM: 260, tiltDeg: 30 })).toBe("Aufnahme von S, Blick nach N (0°), 260 m Höhe, Neigung 30°");
    expect(cameraLine({ viewBearingDeg: 281, heightM: 260, tiltDeg: 18.2 })).toBe("Aufnahme von O, Blick nach W (281°), 260 m Höhe, Neigung 18°");
    expect(slotLabel("title")).toBe("Titelbild");
    expect(slotLabel("view-2")).toBe("Weitere Ansicht 2");
  });
});

describe("decisions on a place_image task", () => {
  it("approve writes place_images with attribution naming aerial and terrain source", () =>
    withRollback(async (tx) => {
      const s = await spot(tx);
      const archive = memoryArchive();
      const { task } = await generated(tx, s, archive);
      const result = await decide(tx, task!, { action: "approve_image" }, archive);
      expect(result.regenerateImage).toBeNull();

      const [image] = await currentImages(tx, s.objectId);
      const images = cfg.images;
      expect(image).toMatchObject({
        slot: "title",
        sortOrder: 0,
        kind: "ai_illustration",
        rank: 3,
        renderId: task!.context.renderId,
        light: "midday",
        model: task!.context.model,
        promptVersion: String(task!.context.promptVersion),
        waterIou: 1,
        generationKey: task!.context.key,
        alt: task!.context.alt,
        license: images.output.license,
        observedAt: images.sources.sentinel2.acquiredAt,
        validFrom: "2026-10-21",
      });
      expect(image!.attribution).toBe(
        [images.sources.ktimatologio.attribution, images.sources.sentinel2.attribution, images.sources.copernicus_dem.attribution, images.output.credit].join(" · "),
      );
      // the candidate copied to its final key, with its size
      expect(image!.fileKey).toBe(`images/places/${s.objectId}/${image!.id}.jpg`);
      const bytes = await archive.get(image!.fileKey);
      expect(bytes).toEqual(await archive.get(task!.context.candidateKey!));
      const meta = await sharp(bytes!).metadata();
      expect([image!.width, image!.height]).toEqual([meta.width, meta.height]);
      // the decision row is the image's review decision; the task is decided
      const { rows } = await tx.execute<{ task_id: string }>(sql`select task_id from review_decisions where id = ${image!.reviewDecisionId}`);
      expect(rows[0]!.task_id).toBe(task!.id);
      const [row] = await tx.select({ status: reviewTasks.status }).from(reviewTasks).where(eq(reviewTasks.id, task!.id));
      expect(row!.status).toBe("decided");
    }));

  it("approve ends the previous image of the same slot and keeps other slots", () =>
    withRollback(async (tx) => {
      const s = await spot(tx);
      const archive = memoryArchive();
      const first = await generated(tx, s, archive);
      await decide(tx, first.task!, { action: "approve_image" }, archive);
      const view = await generated(tx, s, archive, { slot: "view-2", zoom: "z1", azimuthDeg: 90 });
      await decide(tx, view.task!, { action: "approve_image" }, archive);
      // a new model is a new key: a second title image
      const second = await generated(tx, s, archive, TITLE, "gpt-image-test");
      expect(second.task!.context.key).not.toBe(first.task!.context.key);
      await decide(tx, second.task!, { action: "approve_image" }, archive);

      const current = await currentImages(tx, s.objectId);
      expect(current.map((i) => [i.slot, i.sortOrder, i.generationKey])).toEqual([
        ["title", 0, second.task!.context.key],
        ["view-2", 1, view.task!.context.key],
      ]);
      const ended = await tx.select().from(placeImages).where(and(eq(placeImages.geoObjectId, s.objectId), eq(placeImages.generationKey, first.task!.context.key)));
      expect(ended.map((i) => i.validTo)).toEqual(["2026-10-21"]);
    }));

  it("approved image carries camera position, height, bearing, tilt and fov", () =>
    withRollback(async (tx) => {
      const s = await spot(tx);
      const archive = memoryArchive();
      const { task } = await generated(tx, s, archive);
      await decide(tx, task!, { action: "approve_image" }, archive);
      const [image] = await tx
        .select({
          position: asGeoJson(placeImages.cameraPosition),
          heightM: placeImages.cameraHeightM,
          bearing: placeImages.viewBearingDeg,
          tilt: placeImages.cameraTiltDeg,
          fov: placeImages.cameraFovDeg,
        })
        .from(placeImages)
        .where(and(eq(placeImages.geoObjectId, s.objectId), isNull(placeImages.validTo)));
      const camera = task!.context.camera!;
      const [lon, lat] = (image!.position as GeoJSON.Point).coordinates;
      expect(lon).toBeCloseTo(camera.position[0], 9);
      expect(lat).toBeCloseTo(camera.position[1], 9);
      expect(image!.heightM).toBe(camera.heightM);
      expect(image!.bearing).toBeCloseTo(camera.viewBearingDeg, 4);
      expect(image!.tilt).toBeCloseTo(camera.tiltDeg, 4);
      expect(image!.fov).toBeCloseTo(camera.fovDeg, 4);
    }));

  it("approve after context change throws TaskContextChanged and writes nothing", () =>
    withRollback(async (tx) => {
      const s = await spot(tx);
      const archive = memoryArchive();
      const { task } = await generated(tx, s, archive);
      // a later run replaced the task's question while the form was open
      await tx
        .update(reviewTasks)
        .set({ context: sql`jsonb_set(${reviewTasks.context}, '{key}', '"0000000000000000"')` })
        .where(eq(reviewTasks.id, task!.id));
      await expect(decide(tx, task!, { action: "approve_image" }, archive)).rejects.toBeInstanceOf(TaskContextChanged);
      // without a key the form is no current form either
      await expect(
        decideReviewTask(tx, { taskId: task!.id, decision: { action: "approve_image" }, decidedBy: ADMIN }, { archive }),
      ).rejects.toBeInstanceOf(TaskContextChanged);
      expect(await currentImages(tx, s.objectId)).toEqual([]);
      const [row] = await tx.select({ status: reviewTasks.status }).from(reviewTasks).where(eq(reviewTasks.id, task!.id));
      expect(row!.status).toBe("open");
      const { rows } = await tx.execute<{ n: number }>(sql`select count(*)::int as n from review_decisions where task_id = ${task!.id}`);
      expect(rows[0]!.n).toBe(0);
    }));

  it("approve is refused for a task without candidate", () =>
    withRollback(async (tx) => {
      const s = await spot(tx);
      const archive = memoryArchive();
      const { task } = await generated(tx, s, archive);
      await tx
        .update(reviewTasks)
        .set({ context: sql`${reviewTasks.context} || '{"candidateKey": null, "reason": "no_valid_output"}'::jsonb` })
        .where(eq(reviewTasks.id, task!.id));
      await expect(decide(tx, task!, { action: "approve_image" }, archive)).rejects.toBeInstanceOf(DecisionNotAllowed);
      expect(await currentImages(tx, s.objectId)).toEqual([]);
    }));

  it("no_image ends the current image and the same key is not targeted again", () =>
    withRollback(async (tx) => {
      const s = await spot(tx);
      const archive = memoryArchive();
      const view = await generated(tx, s, archive, { slot: "view-2", zoom: "z1", azimuthDeg: 90 });
      await decide(tx, view.task!, { action: "approve_image" }, archive);
      const first = await generated(tx, s, archive);
      await decide(tx, first.task!, { action: "approve_image" }, archive);
      const second = await generated(tx, s, archive, TITLE, "gpt-image-test");
      await decide(tx, second.task!, { action: "no_image" }, archive);

      // the title image ended, the other view stays
      expect((await currentImages(tx, s.objectId)).map((i) => i.slot)).toEqual(["view-2"]);
      const [row] = await tx.select({ status: reviewTasks.status }).from(reviewTasks).where(eq(reviewTasks.id, second.task!.id));
      expect(row!.status).toBe("decided");
      // the key of the decided task is done: neither the planner nor a job generates it again
      const testCfg = { ...cfg, models: { ...cfg.models, imageTasks: { "generate-place-image": { ...cfg.models.imageTasks["generate-place-image"]!, model: "gpt-image-test" } } } };
      expect(await imageTargets(tx, { id: s.runId, params: { images: { geoObjectId: s.objectId, view: TITLE } } }, testCfg)).toEqual([]);
      const again = await generated(tx, s, archive, TITLE, "gpt-image-test");
      expect(again.result.status).toBe("skipped");
    }));

  it("no_image on a task without candidate keeps the current image; its key is still decided", () =>
    withRollback(async (tx) => {
      const s = await spot(tx);
      const archive = memoryArchive();
      const first = await generated(tx, s, archive);
      await decide(tx, first.task!, { action: "approve_image" }, archive);
      expect((await currentImages(tx, s.objectId)).map((i) => i.slot)).toEqual(["title"]);
      // the next stand found no usable output: a task without candidate
      const second = await generated(tx, s, archive, TITLE, "gpt-image-test");
      await tx
        .update(reviewTasks)
        .set({ context: sql`${reviewTasks.context} || '{"candidateKey": null, "reason": "no_valid_output"}'::jsonb` })
        .where(eq(reviewTasks.id, second.task!.id));
      await decide(tx, second.task!, { action: "no_image" }, archive);
      // nothing to decline: the approved image stays current
      expect((await currentImages(tx, s.objectId)).map((i) => i.slot)).toEqual(["title"]);
      const [row] = await tx.select({ status: reviewTasks.status }).from(reviewTasks).where(eq(reviewTasks.id, second.task!.id));
      expect(row!.status).toBe("decided");
      const testCfg = { ...cfg, models: { ...cfg.models, imageTasks: { "generate-place-image": { ...cfg.models.imageTasks["generate-place-image"]!, model: "gpt-image-test" } } } };
      expect(await imageTargets(tx, { id: s.runId, params: { images: { geoObjectId: s.objectId, view: TITLE } } }, testCfg)).toEqual([]);
      // a task without candidate key alone (no reason) declines nothing either
      const third = await generated(tx, s, archive, TITLE, "gpt-image-test-2");
      await tx.update(reviewTasks).set({ context: sql`${reviewTasks.context} || '{"candidateKey": null}'::jsonb` }).where(eq(reviewTasks.id, third.task!.id));
      await decide(tx, third.task!, { action: "no_image" }, archive);
      expect((await currentImages(tx, s.objectId)).map((i) => i.slot)).toEqual(["title"]);
    }));

  it("regenerate_image returns regenerateImage with zoom", () =>
    withRollback(async (tx) => {
      const s = await spot(tx);
      const archive = memoryArchive();
      const { task } = await generated(tx, s, archive);
      expect(task!.context.allowedZooms).toContain("z2");
      const result = await decide(tx, task!, { action: "regenerate_image", zoom: "z2" }, archive);
      expect(result.regenerateImage).toEqual({ geoObjectId: s.objectId, view: { slot: "title", zoom: "z2" }, force: true });
      expect(result.consolidate).toBeNull();
      const [row] = await tx.select({ status: reviewTasks.status }).from(reviewTasks).where(eq(reviewTasks.id, task!.id));
      expect(row!.status).toBe("decided");
      expect(await currentImages(tx, s.objectId)).toEqual([]);
    }));

  it("regenerate_image without a zoom keeps the view's zoom and rotation start", () =>
    withRollback(async (tx) => {
      const s = await spot(tx);
      const archive = memoryArchive();
      const { task } = await generated(tx, s, archive, { slot: "view-2", zoom: "z1", azimuthDeg: 90 });
      const result = await decide(tx, task!, { action: "regenerate_image" }, archive);
      expect(result.regenerateImage).toEqual({ geoObjectId: s.objectId, view: { slot: "view-2", zoom: "z1", azimuthDeg: 90 }, force: true });
    }));

  it("regenerate_image refuses a zoom outside allowedZooms", () =>
    withRollback(async (tx) => {
      const s = await spot(tx);
      const archive = memoryArchive();
      const { task } = await generated(tx, s, archive);
      await tx
        .update(reviewTasks)
        .set({ context: sql`${reviewTasks.context} || '{"allowedZooms": ["z1"]}'::jsonb` })
        .where(eq(reviewTasks.id, task!.id));
      await expect(decide(tx, task!, { action: "regenerate_image", zoom: "z3" }, archive)).rejects.toBeInstanceOf(DecisionNotAllowed);
      const [row] = await tx.select({ status: reviewTasks.status }).from(reviewTasks).where(eq(reviewTasks.id, task!.id));
      expect(row!.status).toBe("open");
    }));

  it("regenerate with same zoom really generates again", () =>
    withRollback(async (tx) => {
      const s = await spot(tx);
      const archive = memoryArchive();
      const { task } = await generated(tx, s, archive);
      const { regenerateImage } = await decide(tx, task!, { action: "regenerate_image", zoom: "z1" }, archive);
      // the same key, now on a decided task: without force it is done
      expect(await imageTargets(tx, { id: s.runId, params: { images: { geoObjectId: s.objectId, view: TITLE } } })).toEqual([]);
      expect((await generated(tx, s, archive)).result.status).toBe("skipped");
      // the run of the decision (`startImageRun` with force) plans and generates it again
      const scope = { geoObjectId: s.objectId, view: regenerateImage!.view, force: true };
      expect(await imageTargets(tx, { id: s.runId, params: { images: scope } })).toEqual([{ geoObjectId: s.objectId, view: TITLE, force: true }]);
      const again = await generated(tx, s, archive, TITLE, undefined, true);
      expect(again.result.status).toBe("review");
      expect(again.task!.id).not.toBe(task!.id);
      expect(again.task!.context.key).toBe(task!.context.key);
      // a retried forced job finds the open task with its key and changes nothing
      expect((await generated(tx, s, archive, TITLE, undefined, true)).result.status).toBe("skipped");
    }));
});
