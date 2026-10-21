import { sql } from "drizzle-orm";
import type { Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import { RetryableHttpError } from "@/lib/adapters/http";
import { ImageOutputInvalid } from "@/lib/adapters/openai-image";
import type { Archive } from "@/lib/adapters/s3";
import { MockImageModel } from "@/lib/ai/mock-image";
import { MockModel } from "@/lib/ai/mock";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { landPolygons, reviewTasks } from "@/lib/db/schema";
import { BudgetExceeded } from "@/lib/domain/costs";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { createRun } from "@/lib/domain/runs";
import { generatePlaceImage, generationKey, slotLockKey, type ImageView } from "@/lib/pipeline/images/generate";
import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";
import { testDb, withRollback } from "@/test/db";
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

async function fixture(tx: Db, kind: "anchorage" | "marina" = "anchorage", o: { lon?: number } = {}) {
  const sd = await insertImageSubdivision(tx);
  const spot = await insertSpot(tx, sd.id, { kind, ...o });
  const run = await createRun(tx, { kind: "stage", scope: { type: "system", id: "test" }, stages: [IMAGES_STAGE], triggeredBy: "test" });
  return { ...spot, runId: run.id };
}

async function deps(archive: Archive, imageModelAnswers: MockImageModel, model: MockModel) {
  return { archive, transport: await syntheticImageryTransport(), imageModel: imageModelAnswers, model, render: stubRender };
}

const taskOf = imageTasksOf;

/** The automatic title view: no zoom, the composition and the imagery choose it (`titleZoomFor`). */
const TITLE: ImageView = { slot: "title" };

/** The candidate key of attempt `n` (a pattern) of a generation over `renderId`: `<renderId>-<generation id>-<n>.jpg`. */
const candidateKeyOf = (geoObjectId: string, renderId: string, n: string) => new RegExp(`^imagery/candidates/${geoObjectId}/${renderId}-[0-9a-f-]{36}-${n}\\.jpg$`);

describe("generationKey", () => {
  it("is independent of the tile order and changes with each field", () => {
    const base = {
      imageryTileIds: ["b", "a"], promptVersion: 1, model: "m", kind: "anchorage" as const, light: "midday" as const, slot: "title", zoom: "z1" as const,
      azimuthDeg: null, rulesVersion: "camera-2",
    };
    const key = generationKey(base);
    expect(generationKey({ ...base, imageryTileIds: ["a", "b"] })).toBe(key);
    expect(generationKey({ ...base, promptVersion: 2 })).not.toBe(key);
    expect(generationKey({ ...base, rulesVersion: "camera-1" })).not.toBe(key);
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
      expect(task!.context).toMatchObject({ slot: "title", passed: false, attempts: 2, waterIoU: 0, light: "midday", zoom: "z2", azimuthOverride: null, watermarkVisible: false });
      expect(task!.context.candidateKey).toMatch(candidateKeyOf(f.objectId, task!.context.renderId!, "[12]"));
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
      // the edit names its place and slot (recorded in external_calls.meta for the cost per Landesteil)
      expect(images.calls[0]).toMatchObject({ task: "generate-place-image", subject: { geoObjectId: f.objectId, slot: "title" } });
      const [task] = await taskOf(tx, `${f.objectId}:title`);
      const c = task!.context;
      const task0 = cfg.models.imageTasks["generate-place-image"]!;
      expect(c).toMatchObject({ slot: "title", passed: true, attempts: 1, waterIoU: 1, watermarkVisible: false, model: task0.model, promptVersion: task0.promptVersion, allowedZooms: ["z1", "z2", "z3"] });
      expect(c.candidateKey).toMatch(candidateKeyOf(f.objectId, c.renderId!, "1"));
      expect(c.alt.startsWith("KI-Illustration:")).toBe(true);
      // camera details: rays longest towards the south, so the camera looks north; the open-water title image takes
      // z2 (0.5 m cadastre), the shore 400 m north puts the target 475 m north of the centre and the camera 277 m
      // before it: 198 m north of the centre, over the bay before its shoreline
      expect(c.zoom).toBe("z2");
      expect(c.camera!.viewBearingDeg).toBeCloseTo(0, 6);
      expect(c.camera!.heightM).toBe(160);
      expect(c.camera!.position[1]).toBeGreaterThan(IMAGE_LAT);
      expect(c.camera!.position[1]).toBeLessThan(IMAGE_LAT + 400 / 110_960);
      // the key stored with the render is the task's key
      const { rows } = await tx.execute<{ generation_key: string }>(sql`select generation_key from place_renders where id = ${c.renderId}`);
      expect(rows[0]!.generation_key).toBe(c.key);
    });
  });

  it("title view takes z1 when the cadastre is blank (Sentinel-2 only); an explicit zoom wins", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      const blank = { ...(await deps(archive, await imageModel(GOOD), checker(false))), transport: await syntheticImageryTransport({ blankCadastre: true }) };
      const result = await generatePlaceImage(tx, { geoObjectId: f.objectId, view: TITLE, runId: f.runId }, blank);
      expect(result.status).toBe("review");
      const [task] = await taskOf(tx, `${f.objectId}:title`);
      expect(task!.context).toMatchObject({ zoom: "z1", allowedZooms: ["z1"] });
      expect(task!.context.camera!.heightM).toBe(260);

      // „Neu erzeugen“ at z1 over the fine cadastre (another spot, 0.1° east of the blank tiles): z1 as asked,
      // although the imagery would allow z2
      const g = await fixture(tx, "anchorage", { lon: IMAGE_LON + 0.1 });
      await generatePlaceImage(tx, { geoObjectId: g.objectId, view: { slot: "title", zoom: "z1" }, runId: g.runId }, await deps(archive, await imageModel(GOOD), checker(false)));
      const [explicit] = await taskOf(tx, `${g.objectId}:title`);
      expect(explicit!.context).toMatchObject({ zoom: "z1", allowedZooms: ["z1", "z2", "z3"] });
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
      expect(task!.context.candidateKey).toMatch(candidateKeyOf(f.objectId, task!.context.renderId!, "2"));
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
      expect(task!.context.candidateKey).toMatch(candidateKeyOf(f.objectId, task!.context.renderId!, "1"));
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

  it("a failing watermark check keeps the paid image as an unchecked attempt and ends the attempts; a budget stop still reaches the worker", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      const images = await imageModel(GOOD);
      const failingChecker = new MockModel({
        "check-place-image": () => {
          throw new BudgetExceeded("anthropic", 20, 20);
        },
      });
      const input = { geoObjectId: f.objectId, view: TITLE, runId: f.runId };
      // the task exists with the paid image, and the budget stop propagates so the worker pauses the queue
      await expect(generatePlaceImage(tx, input, await deps(archive, images, failingChecker))).rejects.toBeInstanceOf(BudgetExceeded);
      expect(images.calls).toHaveLength(1);
      const [task] = await taskOf(tx, `${f.objectId}:title`);
      expect(task!.context).toMatchObject({ passed: false, attempts: 1, waterIoU: 1, watermarkVisible: null, interrupted: { attempt: 1, error: "BudgetExceeded: Daily budget for anthropic exceeded: 20 of 20 EUR" } });
      expect(task!.context.candidateKey).toMatch(candidateKeyOf(f.objectId, task!.context.renderId!, "1"));
      // the job the worker re-sends after the pause finds the open task and skips
      expect((await generatePlaceImage(tx, input, await deps(archive, await imageModel(GOOD), checker(false)))).status).toBe("skipped");
      expect(await taskOf(tx, `${f.objectId}:title`)).toHaveLength(1);
      // a provider failure of the check (no budget stop) ends the attempts without failing the job
      const g = await fixture(tx);
      const flaky = new MockModel({
        "check-place-image": () => {
          throw new RetryableHttpError("anthropic 529", 529);
        },
      });
      const result = await generatePlaceImage(tx, { geoObjectId: g.objectId, view: TITLE, runId: g.runId }, await deps(memoryArchive(), await imageModel(GOOD), flaky));
      expect(result).toEqual({ status: "review", attempts: 1, waterIoU: 1 });
    });
  });

  it("a budget stop of the edit after a paid attempt puts the attempt up for review and still propagates", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      const images = await imageModel(DRY, new BudgetExceeded("openai", 10, 10));
      await expect(generatePlaceImage(tx, { geoObjectId: f.objectId, view: TITLE, runId: f.runId }, await deps(archive, images, checker(false)))).rejects.toBeInstanceOf(BudgetExceeded);
      expect(images.calls).toHaveLength(2);
      const [task] = await taskOf(tx, `${f.objectId}:title`);
      expect(task!.context).toMatchObject({ passed: false, attempts: 2, waterIoU: 0, interrupted: { attempt: 2, error: "BudgetExceeded: Daily budget for openai exceeded: 10 of 10 EUR" } });
      expect(task!.context.candidateKey).toMatch(candidateKeyOf(f.objectId, task!.context.renderId!, "1"));
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

  it("without a usable image model the job is skipped before imagery, render and edit", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const images = new MockImageModel(() => new Error("unreachable"), { available: false });
      const result = await generatePlaceImage(
        tx,
        { geoObjectId: f.objectId, view: TITLE, runId: f.runId },
        { archive: memoryArchive(), transport: refusingTransport, imageModel: images, model: checker(false), render: stubRender },
      );
      expect(result).toEqual({ status: "skipped", attempts: 0, waterIoU: null });
      expect(images.calls).toHaveLength(0);
      expect(await taskOf(tx, `${f.objectId}:title`)).toEqual([]);
    });
  });

  it("a retried job reuses the render of its key; a forced job or a lost archive object renders anew", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      let renders = 0;
      const countingRender: typeof stubRender = (...args) => {
        renders++;
        return stubRender(...args);
      };
      const input = { geoObjectId: f.objectId, view: TITLE, runId: f.runId };
      // the first job renders, then the provider fails before any image: the job fails and is retried
      const failing = await imageModel(new RetryableHttpError("openai images.edit POST: 503", 503));
      const d = { ...(await deps(archive, failing, checker(false))), render: countingRender };
      await expect(generatePlaceImage(tx, input, d)).rejects.toBeInstanceOf(RetryableHttpError);
      expect(renders).toBe(1);
      const { rows } = await tx.execute<{ id: string }>(sql`select id from place_renders where geo_object_id = ${f.objectId}`);
      expect(rows).toHaveLength(1);
      // the retry paints over the render it already has
      const retry = await generatePlaceImage(tx, input, { ...d, imageModel: await imageModel(GOOD) });
      expect(retry.status).toBe("review");
      expect(renders).toBe(1);
      const [task] = await taskOf(tx, `${f.objectId}:title`);
      expect(task!.context.renderId).toBe(rows[0]!.id);
      // „Neu erzeugen“ at the same zoom (force, the task decided) renders anew: its candidates must not overwrite the decided task's
      await tx.execute(sql`update review_tasks set status = 'decided' where id = ${task!.id}`);
      const forced = await generatePlaceImage(tx, { ...input, force: true }, { ...d, imageModel: await imageModel(GOOD) });
      expect(forced.status).toBe("review");
      expect(renders).toBe(2);
      const [forcedTask] = await taskOf(tx, `${f.objectId}:title`);
      expect(forcedTask!.context.renderId).not.toBe(rows[0]!.id);
      // a render whose photo or mask is gone from the archive is not reused either (the key not done: no task decided or open)
      await tx.execute(sql`update review_tasks set status = 'dismissed' where id in (${task!.id}, ${forcedTask!.id})`);
      const again = await generatePlaceImage(tx, input, { ...d, archive: memoryArchive(), imageModel: await imageModel(GOOD) });
      expect(again.status).toBe("review");
      expect(renders).toBe(3);
    });
  });

  it("a generation over a reused render names its candidate apart from the decided task's, which keeps its image", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      const input = { geoObjectId: f.objectId, view: TITLE, runId: f.runId };
      await generatePlaceImage(tx, input, await deps(archive, await imageModel(GOOD), checker(false)));
      const [first] = await taskOf(tx, `${f.objectId}:title`);
      const firstCandidate = first!.context.candidateKey!;
      const firstBytes = (await archive.get(firstCandidate))!;
      // approved, then removed („Bild entfernen“): the next automatic run generates the same key again over the same render
      await decideReviewTask(tx, { taskId: first!.id, decision: { action: "approve_image" }, decidedBy: "admin", taskKey: first!.context.key }, { archive });
      await tx.execute(sql`update place_images set valid_to = current_date where geo_object_id = ${f.objectId}`);
      const again = await generatePlaceImage(tx, input, await deps(archive, await imageModel(DRY), checker(false)));
      expect(again.status).toBe("review");
      const [second] = await taskOf(tx, `${f.objectId}:title`);
      expect(second!.context.renderId).toBe(first!.context.renderId);
      expect(second!.context.candidateKey).not.toBe(firstCandidate);
      expect(second!.context.candidateKey).toMatch(candidateKeyOf(f.objectId, first!.context.renderId!, "[12]"));
      // the decided task still shows the image it was decided on
      expect(Buffer.from((await archive.get(firstCandidate))!).equals(Buffer.from(firstBytes))).toBe(true);
      expect(Buffer.from((await archive.get(second!.context.candidateKey!))!).equals(Buffer.from(firstBytes))).toBe(false);
    });
  });

  it("two concurrent jobs of the same slot generate one image: the other is skipped by the slot lock", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const archive = memoryArchive();
      const images = await imageModel(GOOD);
      // the lock on the pool: each call gets a session of its own, as the worker's jobs do
      const d = { ...(await deps(archive, images, checker(false))), lockDb: testDb() };
      const input = { geoObjectId: f.objectId, view: TITLE, runId: f.runId };
      const results = await Promise.all([generatePlaceImage(tx, input, d), generatePlaceImage(tx, input, d)]);
      expect(results.map((r) => r.status).sort()).toEqual(["review", "skipped"]);
      expect(images.calls).toHaveLength(1);
      expect(await taskOf(tx, `${f.objectId}:title`)).toHaveLength(1);
      // the lock is released with the job: a third call finds the open task with its key
      expect((await generatePlaceImage(tx, input, d)).status).toBe("skipped");
    });
  });

  it("a slot locked by another job is skipped before any imagery, render or edit", async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const images = await imageModel(GOOD);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = testDb().transaction(async (other) => {
        await other.execute(sql`select pg_advisory_xact_lock(hashtext(${slotLockKey(f.objectId, "title")}))`);
        locked();
        await held;
      });
      await isLocked;
      try {
        const result = await generatePlaceImage(
          tx,
          { geoObjectId: f.objectId, view: TITLE, runId: f.runId },
          { archive: memoryArchive(), transport: refusingTransport, imageModel: images, model: checker(false), render: stubRender, lockDb: testDb() },
        );
        expect(result).toEqual({ status: "skipped", attempts: 0, waterIoU: null });
        expect(images.calls).toHaveLength(0);
        expect(await taskOf(tx, `${f.objectId}:title`)).toEqual([]);
      } finally {
        release();
        await holder;
      }
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
