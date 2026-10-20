import { and, eq, isNull, sql } from "drizzle-orm";
import type { Transport } from "@/lib/adapters/http";
import { ImageOutputInvalid, type ImageModel } from "@/lib/adapters/openai-image";
import type { Archive } from "@/lib/adapters/s3";
import { checkPlaceImageTask } from "@/lib/ai/tasks/check-place-image";
import { ModelOutputInvalid, type ModelClient } from "@/lib/ai/types";
import { getConfig, type AppConfig, type ImageryLight, type ZoomLevel } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { placeImages, reviewDecisions, reviewTasks, type PlaceKind } from "@/lib/db/schema";
import { passesGeometry, toJpeg, waterIoU } from "@/lib/domain/images/checks";
import { lightFor } from "@/lib/domain/images/light";
import { loadPlaceImageInput, type PlaceImageInput } from "@/lib/domain/images/place-input";
import { altText, buildPlacePrompt } from "@/lib/domain/images/prompt";
import { allowedZooms, cameraDetails, planRender, type CameraDetails, type RenderCamera } from "@/lib/domain/images/render-plan";
import { createReviewTask, hasDecidedTask } from "@/lib/domain/review";
import { dismissTasks } from "@/lib/domain/consolidation/task-locks";
import { valueFingerprint } from "@/lib/domain/review-decisions";
import { createLogger } from "@/lib/logger";
import { ensureImagery, type ImagerySet } from "./imagery";
import { renderAndStore } from "./render";
import { IMAGES_STAGE } from "./stage-name";

/*
 * Stage `images.place` (spec 13), one job: plan the camera, fetch the imagery around its target, render, let the image
 * model paint over the render, check water and watermarks, and put the best attempt up for review as a `place_image`
 * task. The model calls run outside any transaction (pattern of `summarizeProfile`).
 */

const TASK = "generate-place-image";
const log = createLogger("images.place");

/** `<name>: <message>` of an error (anything else as text), for a task context. */
const errorMessage = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** The configuration the image stage reads (tests pass a changed copy). */
export type ImageStageConfig = Pick<AppConfig, "images" | "models" | "delivery">;

/**
 * Which image of a place: its slot (`title` from the pipeline, `view-<n>` added by an admin), the zoom level and, for
 * an additional view, the bearing the camera rotation starts at (`planRender`'s `azimuthOverride`).
 */
export type ImageView = { slot: string; zoom: ZoomLevel; azimuthDeg?: number };

/** The automatic view: the title image at the default zoom. */
export const titleView = (cfg: Pick<AppConfig, "images"> = getConfig()): ImageView => ({ slot: "title", zoom: cfg.images.camera.defaultZoom });

/** Context of a `place_image` review task (subject `<geoObjectId>:<slot>`); the review approval (Task 9) reads it. */
export type PlaceImageTaskContext = {
  key: string;
  slot: string;
  azimuthOverride: number | null;
  camera: CameraDetails | null;
  renderId: string | null;
  candidateKey: string | null;
  light: ImageryLight;
  zoom: ZoomLevel;
  model: string;
  promptVersion: number;
  waterIoU: number | null;
  passed: boolean;
  attempts: number;
  watermarkVisible: boolean | null;
  alt: string;
  allowedZooms: ZoomLevel[];
  /** `no_water_view`: no camera over water; `no_valid_output`: every attempt failed without an image (no candidate). */
  reason?: "no_water_view" | "no_valid_output";
  /**
   * An attempt after the first paid image ended in an error (budget, provider, network, the watermark check): the
   * attempts made until then went up for review instead of being thrown away with a failing job.
   */
  interrupted?: { attempt: number; error: string };
};

/**
 * Fingerprint of everything an image depends on: the aerial tiles (sorted ids of core and wide), prompt version,
 * model, place kind, light, slot, zoom and the rotation start. A new image is generated only when it changes.
 */
export function generationKey(input: {
  imageryTileIds: string[];
  promptVersion: number;
  model: string;
  kind: PlaceKind;
  light: ImageryLight;
  slot: string;
  zoom: ZoomLevel;
  azimuthDeg: number | null;
}): string {
  return valueFingerprint({ ...input, imageryTileIds: [...input.imageryTileIds].sort() });
}

/** The model and prompt version of the image task (part of the generation key). */
export function imageTaskOf(cfg: Pick<AppConfig, "models">): { model: string; promptVersion: number } {
  const task = cfg.models.imageTasks[TASK];
  if (!task) throw new Error(`config/models.json has no image task ${TASK}`);
  return { model: task.model, promptVersion: task.promptVersion };
}

/** The generation key of `view` of a planned place for the aerial tiles `imageryTileIds` (none for `no_water_view`). */
export function keyFor(input: PlaceImageInput, view: ImageView, imageryTileIds: string[], cfg: ImageStageConfig): string {
  const { model, promptVersion } = imageTaskOf(cfg);
  return generationKey({
    imageryTileIds,
    promptVersion,
    model,
    kind: input.kind,
    light: lightFor(input, cfg.images),
    slot: view.slot,
    zoom: view.zoom,
    azimuthDeg: view.azimuthDeg ?? null,
  });
}

/** The image of `place` with its imagery windows centred on the camera target (the render and its imagery agree). */
export const atTarget = (place: PlaceImageInput, camera: RenderCamera): PlaceImageInput => ({ ...place, lon: camera.target[0], lat: camera.target[1] });

/**
 * Whether `key` is done for `slot` of the place: a current image of the slot, an open task or a decided task carries
 * it. A rejected image („Kein Bild“) is not generated again for the same key either, but a title image that was
 * approved and then removed („Bild entfernen“: no current image of the slot, the latest decision on the key was
 * `approve_image`) is: the next automatic run generates it again. Only the latest decided task of the key counts, so an
 * earlier „Neu erzeugen“ at the same zoom (its decided task carries the key too) does not keep a removed image away. A
 * removed further view does not come back. With `force` (an admin's „Neu erzeugen“ at the same zoom), a decided task
 * does not count; a current image or an open task still does, so a retried forced job changes nothing.
 */
export async function keyDone(db: Db, geoObjectId: string, slot: string, key: string, force = false): Promise<boolean> {
  const [image] = await db
    .select({ id: placeImages.id })
    .from(placeImages)
    .where(and(eq(placeImages.geoObjectId, geoObjectId), eq(placeImages.slot, slot), isNull(placeImages.validTo), eq(placeImages.generationKey, key)))
    .limit(1);
  if (image) return true;
  const subjectId = `${geoObjectId}:${slot}`;
  const [open] = await db
    .select({ id: reviewTasks.id })
    .from(reviewTasks)
    .where(
      and(
        eq(reviewTasks.kind, "place_image"),
        eq(reviewTasks.subjectId, subjectId),
        eq(reviewTasks.status, "open"),
        sql`${reviewTasks.context} @> ${JSON.stringify({ key })}::jsonb`,
      ),
    )
    .limit(1);
  if (open) return true;
  if (force) return false;
  if (slot !== "title") return hasDecidedTask(db, "place_image", subjectId, { key });
  // Title slot: the latest decided task of the key is done, except one that approved an image which has since been
  // removed („Bild entfernen“): without a current image of the slot, the next automatic run generates the title image
  // again. A task decided without a decision row (never written by `decideReviewTask`) counts as not approved.
  const { rows } = await db.execute<{ approved: boolean }>(sql`
    select coalesce(d.decision->>'action', '') = 'approve_image' as approved
    from ${reviewTasks} t
    left join lateral (
      select id, decision, decided_at from ${reviewDecisions} where task_id = t.id order by decided_at desc, id desc limit 1
    ) d on true
    where t.kind = 'place_image' and t.subject_id = ${subjectId} and t.status = 'decided'
      and t.context @> ${JSON.stringify({ key })}::jsonb
    order by d.decided_at desc nulls last, d.id desc nulls last, t.id desc
    limit 1`);
  if (rows.length === 0) return false;
  if (!rows[0]!.approved) return true;
  const [current] = await db
    .select({ id: placeImages.id })
    .from(placeImages)
    .where(and(eq(placeImages.geoObjectId, geoObjectId), eq(placeImages.slot, slot), isNull(placeImages.validTo)))
    .limit(1);
  return current !== undefined;
}

/**
 * Opens the `place_image` task of the slot with `context`. An open task with another key (older imagery, prompt or
 * model) is dismissed (`superseded`) first, in the same transaction; one with the same key stays as it is.
 */
async function putUpForReview(db: Db, geoObjectId: string, context: PlaceImageTaskContext): Promise<void> {
  const subjectId = `${geoObjectId}:${context.slot}`;
  await db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string; key: string | null }>(sql`
      select id, context->>'key' as key from review_tasks
      where kind = 'place_image' and subject_id = ${subjectId} and status = 'open'
      for update`);
    const stale = rows.filter((r) => r.key !== context.key).map((r) => r.id);
    await dismissTasks(tx, stale, "superseded");
    await createReviewTask(tx, { kind: "place_image", subjectType: "place_image", subjectId, context });
  });
}

/** The advisory lock key of a place's slot (`hashtext` of it): one image generation of the slot at a time. */
export const slotLockKey = (geoObjectId: string, slot: string): string => `place-image:${geoObjectId}:${slot}`;

/**
 * Runs `fn` while holding the advisory lock of the place's slot (`pg_try_advisory_xact_lock` on `slotLockKey`), or
 * returns null at once when another session holds it: two jobs of the same
 * slot (the title image of a consolidation run and of „Titelbilder erzeugen“, a retry of a job pg-boss expired while
 * it was still running) never render and pay for the same image twice. The lock lives in its own transaction on
 * `lockDb`, which writes nothing: with the pool (the worker's `ctx.db`) that is a connection of its own, idle while
 * `fn` runs on `db` (minutes: render and edits; READ COMMITTED holds no snapshot between statements, so vacuum is
 * not held up). Inside one transaction (`lockDb` a `tx`) the lock is reentrant and never refused.
 */
async function withSlotLock<T>(lockDb: Db, geoObjectId: string, slot: string, fn: () => Promise<T>): Promise<T | null> {
  return lockDb.transaction(async (lock) => {
    const { rows } = await lock.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${slotLockKey(geoObjectId, slot)})) as locked`);
    if (!rows[0]!.locked) return null;
    return fn();
  });
}

type Attempt = { n: number; image: Uint8Array; iou: number; watermarkVisible: boolean | null; watermarkFree: boolean; passed: boolean };

/** Best first: passed, then free of watermarks, then the higher IoU, then the earlier attempt. */
function best(attempts: Attempt[]): Attempt | null {
  const sorted = [...attempts].sort(
    (a, b) => Number(b.passed) - Number(a.passed) || Number(b.watermarkFree) - Number(a.watermarkFree) || b.iou - a.iou || a.n - b.n,
  );
  return sorted[0] ?? null;
}

export type GenerateDeps = {
  archive: Archive;
  transport: Transport;
  imageModel: ImageModel;
  /** Model client of the watermark check (`check-place-image`). */
  model: ModelClient;
  /** Renderer (default `renderAndStore`, headless Chromium); tests of the pipeline logic pass a stub. */
  render?: typeof renderAndStore;
  /** Default `getConfig()`. */
  config?: ImageStageConfig;
  /**
   * Where the slot lock is taken (`withSlotLock`; default `db`). The worker's `db` is the pool, so the lock gets a
   * session of its own; a test inside one transaction passes the pool to make two calls compete.
   */
  lockDb?: Db;
};

export type GenerateResult = { status: "review" | "no_water_view" | "skipped"; attempts: number; waterIoU: number | null };

/**
 * Generates one image of a place and puts it up for review:
 * 1. the place's input (`loadPlaceImageInput`) and camera (`planRender` at `view.zoom`, rotation from
 *    `view.azimuthDeg`); `no_water_view` → a task without candidate, no imagery, no render;
 * 2. under the slot lock (`withSlotLock`; held by another job → `skipped`, that job makes the task): the imagery
 *    around the camera target (`ensureImagery`; a near-town target lies between the anchorage and the town, so the
 *    town is in the core window) and the generation key from the tiles it returned; a key already done (`keyDone`,
 *    checked again under the lock: a retried job, or a decision taken meanwhile; with `force` a decided task does
 *    not count) → `skipped`;
 * 3. the render (`renderAndStore`, recording the key);
 * 4. up to `check.maxAttempts` image edits: water IoU against the render mask, and, when the core imagery is
 *    watermarked (the cadastre), the watermark check on the JPEG. `ImageOutputInvalid`, `ModelOutputInvalid`, a low
 *    IoU or a visible watermark make a failed attempt; the first passing one ends the loop. Any other error (budget,
 *    provider, network, a failing check) propagates, so the job is retried, only while no attempt has produced an
 *    image yet; once one has (and is paid for), the error ends the attempts instead, the image of a failed check stays
 *    an unchecked attempt, and the task notes it as `interrupted`;
 * 5. the best attempt (passed, watermark-free, highest IoU) as JPEG under
 *    `imagery/candidates/<geoObjectId>/<renderId>-<n>.jpg`, and the `place_image` task (`putUpForReview`); when no
 *    attempt gave a usable image, the task has no candidate and `reason: "no_valid_output"`.
 * Nothing runs inside a transaction except the task write.
 */
export async function generatePlaceImage(
  db: Db,
  input: { geoObjectId: string; view: ImageView; runId?: string; force?: boolean },
  deps: GenerateDeps,
): Promise<GenerateResult> {
  const cfg = deps.config ?? getConfig();
  const icfg = cfg.images;
  const { view } = input;
  const place = await loadPlaceImageInput(db, input.geoObjectId, icfg);
  if (!place || !place.country) return { status: "skipped", attempts: 0, waterIoU: null };
  const country = place.country;
  const light = lightFor(place, icfg);
  const { model, promptVersion } = imageTaskOf(cfg);
  const azimuthOverride = view.azimuthDeg ?? null;
  const base = { slot: view.slot, azimuthOverride, light, zoom: view.zoom, model, promptVersion, alt: altText(place, light, cfg) };

  const plan = await planRender(db, place, view.zoom, icfg, azimuthOverride);
  if (!plan.ok) {
    const key = keyFor(place, view, [], cfg);
    if (await keyDone(db, input.geoObjectId, view.slot, key, input.force)) return { status: "skipped", attempts: 0, waterIoU: null };
    await putUpForReview(db, input.geoObjectId, {
      ...base,
      key,
      camera: null,
      renderId: null,
      candidateKey: null,
      waterIoU: null,
      passed: false,
      attempts: 0,
      watermarkVisible: null,
      allowedZooms: [],
      reason: "no_water_view",
    });
    return { status: "no_water_view", attempts: 0, waterIoU: null };
  }

  if (!input.runId) throw new Error("generating a place image needs the run id (place_renders.run_id)");
  const runId = input.runId;
  const { camera } = plan;
  // steps 2 to 5 under the slot lock: a second job of the same slot (another run, a retry of an expired job) skips
  const generated = await withSlotLock(deps.lockDb ?? db, input.geoObjectId, view.slot, async (): Promise<GenerateResult> => {
    const target = atTarget(place, camera);
    const imagery = await ensureImagery(
      db,
      deps.archive,
      deps.transport,
      { geoObjectId: place.geoObjectId, lon: target.lon, lat: target.lat, country },
      { db, runId, stage: IMAGES_STAGE },
      icfg,
    );
    const key = keyFor(place, view, aerialIds(imagery), cfg);
    if (await keyDone(db, input.geoObjectId, view.slot, key, input.force)) return { status: "skipped", attempts: 0, waterIoU: null };

    const render = await (deps.render ?? renderAndStore)(db, deps.archive, target, camera, imagery, { runId, generationKey: key, cfg: icfg });
    const photo = await deps.archive.get(render.photoKey);
    const mask = await deps.archive.get(render.maskKey);
    if (!photo || !mask) throw new Error(`render ${render.renderId} is missing in the archive`);

    // only the cadastre is a core source, and only it can carry a watermark into the render
    const watermarked = imagery.coreSource !== null && icfg.sources[imagery.coreSource].watermarked;
    const prompt = buildPlacePrompt(place, light, watermarked, cfg).text;
    const attempts: Attempt[] = [];
    let made = 0;
    let interrupted: PlaceImageTaskContext["interrupted"];
    /** An error after the first paid image ends the attempts instead of the job; the attempts so far go up for review. */
    const interrupt = (n: number, step: string, e: unknown) => {
      interrupted = { attempt: n, error: errorMessage(e) };
      log.warn({ geoObjectId: place.geoObjectId, slot: view.slot, attempt: n, step, err: e }, "image attempt interrupted, earlier attempts go up for review");
    };
    for (let n = 1; n <= icfg.check.maxAttempts; n++) {
      made = n;
      let image: Uint8Array;
      try {
        image = (await deps.imageModel.edit({ task: TASK, image: photo, prompt }, { db, runId, stage: IMAGES_STAGE })).image;
      } catch (e) {
        if (e instanceof ImageOutputInvalid) continue;
        if (attempts.length === 0) throw e;
        interrupt(n, "edit", e);
        break;
      }
      // the image is paid for from here on: a failing check keeps it as an unchecked attempt
      const iou = await waterIoU(mask, image, icfg.check);
      let watermarkVisible: boolean | null = null;
      let checked = !watermarked;
      if (watermarked) {
        try {
          const jpeg = await toJpeg(image, icfg.output.jpegQuality);
          watermarkVisible = (await deps.model.call(checkPlaceImageTask, { image: jpeg }, { runId, stage: IMAGES_STAGE })).output.watermarkVisible;
          checked = true;
        } catch (e) {
          if (!(e instanceof ModelOutputInvalid)) interrupt(n, "watermark check", e);
        }
      }
      const watermarkFree = checked && watermarkVisible !== true;
      const passed = passesGeometry(iou, light, icfg.check) && watermarkFree;
      attempts.push({ n, image, iou, watermarkVisible, watermarkFree, passed });
      if (passed || interrupted) break;
    }

    const chosen = best(attempts);
    let candidateKey: string | null = null;
    if (chosen) {
      candidateKey = `imagery/candidates/${place.geoObjectId}/${render.renderId}-${chosen.n}.jpg`;
      await deps.archive.put(candidateKey, await toJpeg(chosen.image, icfg.output.jpegQuality), "image/jpeg");
    }
    await putUpForReview(db, input.geoObjectId, {
      ...base,
      key,
      camera: cameraDetails(camera),
      renderId: render.renderId,
      candidateKey,
      waterIoU: chosen?.iou ?? null,
      passed: chosen?.passed ?? false,
      attempts: made,
      watermarkVisible: chosen?.watermarkVisible ?? null,
      allowedZooms: allowedZooms(finestResolution(imagery), icfg),
      ...(chosen ? {} : { reason: "no_valid_output" as const }),
      ...(interrupted ? { interrupted } : {}),
    });
    return { status: "review", attempts: made, waterIoU: chosen?.iou ?? null };
  });
  if (generated === null) {
    log.info({ geoObjectId: input.geoObjectId, slot: view.slot }, "another job holds the slot lock, skipped");
    return { status: "skipped", attempts: 0, waterIoU: null };
  }
  return generated;
}

/** Ids of the aerial tiles (core and wide) of an imagery set: the tiles of the generation key. */
export const aerialIds = (imagery: Pick<ImagerySet, "core" | "wide">): string[] => [...imagery.core, ...imagery.wide].map((t) => t.id);

/** The finest resolution the render shows in its core: the non-blank aerial tiles, else the satellite image. */
function finestResolution(imagery: ImagerySet): number {
  const used = [...imagery.core.filter((t) => !t.blank), ...imagery.wide];
  return used.length > 0 ? Math.min(...used.map((t) => t.resolutionM)) : Number.POSITIVE_INFINITY;
}
