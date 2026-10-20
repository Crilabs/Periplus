import { sql } from "drizzle-orm";
import type { Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import { RetryableHttpError } from "@/lib/adapters/http";
import { ImageOutputInvalid } from "@/lib/adapters/openai-image";
import type { Archive } from "@/lib/adapters/s3";
import type { MockImageModel } from "@/lib/ai/mock-image";
import { MockModel } from "@/lib/ai/mock";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { landPolygons, reviewTasks } from "@/lib/db/schema";
import { BudgetExceeded } from "@/lib/domain/costs";
import { createRun } from "@/lib/domain/runs";
import { generatePlaceImage, generationKey } from "@/lib/pipeline/images/generate";
import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";
import { withRollback } from "@/test/db";
import {
  checker,
  DRY,
  GOOD,
  IMAGE_LAT,
  IMAGE_LON,
  imageModel,
  imageTasksOf,
  insertImageSubdivision,
  insertSpot,
  refusingTransport,
  stubRender,
  syntheticImageryTransport,
} from "@/test/images";
import { memoryArchive } from "@/test/s3";

/*
 * generatePlaceImage with the stubbed renderer of test/images.ts (the real one runs in stage.test.ts). The image model
 * answers with images that either match the stub's mask (GOOD, IoU 1) or show no water at all (DRY, IoU 0).
 */

const cfg = getConfig();

async function fixture(tx: Db, kind: "anchorage" | "marina" = "anchorage") {
  const sd = await insertImageSubdivision(tx);
  const spot = await insertSpot(tx, sd.id, { kind });
  const run = await createRun(tx, { kind: "stage", scope: { type: "system", id: "test" }, stages: [IMAGES_STAGE], triggeredBy: "test" });
  return { ...spot, runId: run.id };
}

async function deps(archive: Archive, imageModelAnswers: MockImageModel, model: MockModel) {
  return { archive, transport: await syntheticImageryTransport(), imageModel: imageModelAnswers, model, render: stubRender };
}

const taskOf = imageTasksOf;

const TITLE = { slot: "title", zoom: "z1" as const };

describe("generationKey", () => {
  it("is independent of the tile order and changes with each field", () => {
    const base = { imageryTileIds: ["b", "a"], promptVersion: 1, model: "m", kind: "anchorage" as const, light: "midday" as const, slot: "title", zoom: "z1" as const, azimuthDeg: null };
    const key = generationKey(base);
    expect(generationKey({ ...base, imageryTileIds: ["a", "b"] })).toBe(key);
    expect(generationKey({ ...base, promptVersion: 2 })).not.toBe(key);
    expect(generationKey({ ...base, imageryTileIds: ["a", "c"] })).not.toBe(key);
    expect(generationKey({ ...base, kind: "marina" })).not.toBe(key);
    expect(generationKey({ ...base, slot: "view-2" })).not.toBe(key);
    expect(generationKey({ ...base, azimuthDeg: 90 })).not.toBe(key);
  });
});

describe("generatePlaceImage", () => {
  it("IoU below threshold regenerates once, then creates a review task with passed=false and attempts=2", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      const images = await imageModel(DRY);
      const result = await generatePlaceImage(tx, { geoObjectId: f.objectId, view: TITLE, runId: f.runId }, await deps(archive, images, checker(false)));
      expect(result).toEqual({ status: "review", attempts: 2, waterIoU: 0 });
      expect(images.calls).toHaveLength(2);
      const [task] = await taskOf(tx, `${f.objectId}:title`);
      expect(task!.subject_type).toBe("place_image");
      expect(task!.context).toMatchObject({ slot: "title", passed: false, attempts: 2, waterIoU: 0, light: "midday", zoom: "z1", azimuthOverride: null, watermarkVisible: false });
      expect(task!.context.candidateKey).toMatch(new RegExp(`^imagery/candidates/${f.objectId}/${task!.context.renderId}-[12]\\.jpg$`));
      expect(archive.contentType(task!.context.candidateKey!)).toBe("image/jpeg");
    });
  });

  it("passing first attempt creates a review task with passed=true and attempts=1", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      const images = await imageModel(GOOD);
      const model = checker(false);
      const result = await generatePlaceImage(tx, { geoObjectId: f.objectId, view: TITLE, runId: f.runId }, await deps(archive, images, model));
      expect(result).toEqual({ status: "review", attempts: 1, waterIoU: 1 });
      const [task] = await taskOf(tx, `${f.objectId}:title`);
      const c = task!.context;
      const task0 = cfg.models.imageTasks["generate-place-image"]!;
      expect(c).toMatchObject({ slot: "title", passed: true, attempts: 1, waterIoU: 1, watermarkVisible: false, model: task0.model, promptVersion: task0.promptVersion, allowedZooms: ["z1", "z2", "z3"] });
      expect(c.candidateKey).toBe(`imagery/candidates/${f.objectId}/${c.renderId}-1.jpg`);
      expect(c.alt.startsWith("KI-Illustration:")).toBe(true);
      // camera details: rays longest towards the south, so the camera stands south and looks north
      expect(c.camera!.viewBearingDeg).toBeCloseTo(0, 6);
      expect(c.camera!.heightM).toBe(260);
      expect(c.camera!.position[1]).toBeLessThan(IMAGE_LAT);
      // the key stored with the render is the task's key
      const { rows } = await tx.execute<{ generation_key: string }>(sql`select generation_key from place_renders where id = ${c.renderId}`);
      expect(rows[0]!.generation_key).toBe(c.key);
    });
  });

  it("watermark visible counts as a failed attempt", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      const result = await generatePlaceImage(tx, { geoObjectId: f.objectId, view: TITLE, runId: f.runId }, await deps(archive, await imageModel(GOOD), checker(true, false)));
      expect(result).toEqual({ status: "review", attempts: 2, waterIoU: 1 });
      const [task] = await taskOf(tx, `${f.objectId}:title`);
      expect(task!.context).toMatchObject({ passed: true, attempts: 2, watermarkVisible: false });
      expect(task!.context.candidateKey).toBe(`imagery/candidates/${f.objectId}/${task!.context.renderId}-2.jpg`);
    });
  });

  it("an unusable image counts as a failed attempt", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const result = await generatePlaceImage(
        tx,
        { geoObjectId: f.objectId, view: TITLE, runId: f.runId },
        await deps(memoryArchive(), await imageModel(new ImageOutputInvalid("no b64_json"), GOOD), checker(false)),
      );
      expect(result).toEqual({ status: "review", attempts: 2, waterIoU: 1 });
    });
  });

  it("an error after a paid attempt ends the attempts and puts the paid one up for review (no rethrow)", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      // attempt 1: an image with IoU 0 (paid); attempt 2: the provider fails
      const images = await imageModel(DRY, new RetryableHttpError("openai images.edit POST: 503", 503));
      const result = await generatePlaceImage(tx, { geoObjectId: f.objectId, view: TITLE, runId: f.runId }, await deps(archive, images, checker(false)));
      expect(result).toEqual({ status: "review", attempts: 2, waterIoU: 0 });
      // two calls were made, only the first answered with an image: that one is the candidate
      expect(images.calls).toHaveLength(2);
      const [task] = await taskOf(tx, `${f.objectId}:title`);
      expect(task!.context).toMatchObject({ passed: false, attempts: 2, waterIoU: 0, interrupted: { attempt: 2, error: "RetryableHttpError: openai images.edit POST: 503" } });
      expect(task!.context.reason).toBeUndefined();
      expect(task!.context.candidateKey).toBe(`imagery/candidates/${f.objectId}/${task!.context.renderId}-1.jpg`);
      expect(archive.contentType(task!.context.candidateKey!)).toBe("image/jpeg");
    });
  });

  it("an error before any paid attempt propagates, so the job is retried", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const images = await imageModel(new BudgetExceeded("openai", 10, 10));
      await expect(generatePlaceImage(tx, { geoObjectId: f.objectId, view: TITLE, runId: f.runId }, await deps(memoryArchive(), images, checker(false)))).rejects.toBeInstanceOf(BudgetExceeded);
      expect(images.calls).toHaveLength(1);
      expect(await taskOf(tx, `${f.objectId}:title`)).toEqual([]);
    });
  });

  it("a failing watermark check keeps the paid image as an unchecked attempt and ends the attempts", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      const images = await imageModel(GOOD);
      const failingChecker = new MockModel({
        "check-place-image": () => {
          throw new BudgetExceeded("anthropic", 20, 20);
        },
      });
      const result = await generatePlaceImage(tx, { geoObjectId: f.objectId, view: TITLE, runId: f.runId }, await deps(archive, images, failingChecker));
      expect(result).toEqual({ status: "review", attempts: 1, waterIoU: 1 });
      expect(images.calls).toHaveLength(1);
      const [task] = await taskOf(tx, `${f.objectId}:title`);
      expect(task!.context).toMatchObject({ passed: false, attempts: 1, waterIoU: 1, watermarkVisible: null, interrupted: { attempt: 1, error: "BudgetExceeded: Daily budget for anthropic exceeded: 20 of 20 EUR" } });
      expect(task!.context.candidateKey).toBe(`imagery/candidates/${f.objectId}/${task!.context.renderId}-1.jpg`);
    });
  });

  it("every attempt without a usable image creates a task without candidate and reason no_valid_output", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      const result = await generatePlaceImage(
        tx,
        { geoObjectId: f.objectId, view: TITLE, runId: f.runId },
        await deps(archive, await imageModel(new ImageOutputInvalid("no b64_json")), checker(false)),
      );
      expect(result).toEqual({ status: "review", attempts: 2, waterIoU: null });
      const [task] = await taskOf(tx, `${f.objectId}:title`);
      expect(task!.context).toMatchObject({ reason: "no_valid_output", candidateKey: null, passed: false, attempts: 2, waterIoU: null, watermarkVisible: null });
      expect(task!.context.renderId).not.toBeNull();
      expect(archive.keys().some((k) => k.startsWith("imagery/candidates/"))).toBe(false);
    });
  });

  it("no_water_view creates a task without candidate", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const ring = [[IMAGE_LON - 0.05, IMAGE_LAT - 0.05], [IMAGE_LON + 0.05, IMAGE_LAT - 0.05], [IMAGE_LON + 0.05, IMAGE_LAT + 0.05], [IMAGE_LON - 0.05, IMAGE_LAT + 0.05], [IMAGE_LON - 0.05, IMAGE_LAT - 0.05]];
      const polygon: Polygon = { type: "Polygon", coordinates: [ring] };
      await tx.insert(landPolygons).values({ geom: sql`${geomFromGeoJson(polygon)}`, datasetVersion: "test" });
      const images = await imageModel(GOOD);
      const result = await generatePlaceImage(
        tx,
        { geoObjectId: f.objectId, view: TITLE, runId: f.runId },
        { archive: memoryArchive(), transport: refusingTransport, imageModel: images, model: checker(false), render: stubRender },
      );
      expect(result).toEqual({ status: "no_water_view", attempts: 0, waterIoU: null });
      expect(images.calls).toHaveLength(0);
      const [task] = await taskOf(tx, `${f.objectId}:title`);
      expect(task!.context).toMatchObject({ reason: "no_water_view", renderId: null, candidateKey: null, camera: null, passed: false, attempts: 0, waterIoU: null });
    });
  });

  it("an additional view with azimuthDeg 90 gets its own slot, task subject and camera starting at 90°; the title image stays", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      await generatePlaceImage(tx, { geoObjectId: f.objectId, view: TITLE, runId: f.runId }, await deps(archive, await imageModel(GOOD), checker(false)));
      const view = { slot: "view-2", zoom: "z1" as const, azimuthDeg: 90 };
      await generatePlaceImage(tx, { geoObjectId: f.objectId, view, runId: f.runId }, await deps(archive, await imageModel(GOOD), checker(false)));
      const [title] = await taskOf(tx, `${f.objectId}:title`);
      const [extra] = await taskOf(tx, `${f.objectId}:view-2`);
      expect(title).toBeDefined();
      expect(extra!.context).toMatchObject({ slot: "view-2", azimuthOverride: 90 });
      expect(extra!.context.camera!.viewBearingDeg).toBeCloseTo(270, 6);
      expect(extra!.context.key).not.toBe(title!.context.key);
    });
  });

  it("a retried job with the same key changes nothing; a new key replaces the open task", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      await generatePlaceImage(tx, { geoObjectId: f.objectId, view: TITLE, runId: f.runId }, await deps(archive, await imageModel(GOOD), checker(false)));
      const [first] = await taskOf(tx, `${f.objectId}:title`);
      const again = await generatePlaceImage(tx, { geoObjectId: f.objectId, view: TITLE, runId: f.runId }, await deps(archive, await imageModel(GOOD), checker(false)));
      expect(again.status).toBe("skipped");

      // another model (the prompt version would need a prompt file v2)
      const otherModel = { ...cfg, models: { ...cfg.models, imageTasks: { "generate-place-image": { ...cfg.models.imageTasks["generate-place-image"]!, model: "gpt-image-test" } } } };
      await generatePlaceImage(tx, { geoObjectId: f.objectId, view: TITLE, runId: f.runId }, { ...(await deps(archive, await imageModel(GOOD), checker(false))), config: otherModel });
      const open = await taskOf(tx, `${f.objectId}:title`);
      expect(open).toHaveLength(1);
      expect(open[0]!.id).not.toBe(first!.id);
      expect(open[0]!.context.key).not.toBe(first!.context.key);
      const [dismissed] = await tx.select().from(reviewTasks).where(sql`${reviewTasks.id} = ${first!.id}`);
      expect(dismissed!.status).toBe("dismissed");
    });
  });
});
