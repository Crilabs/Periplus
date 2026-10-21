import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { MockImageModel } from "@/lib/ai/mock-image";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { placeImages, reviewDecisions, runs } from "@/lib/db/schema";
import { createReviewTask } from "@/lib/domain/review";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { createRun } from "@/lib/domain/runs";
import { STAGES } from "@/lib/jobs/stages";
import { consolidateGeoJob, consolidationGeoJobs } from "@/lib/pipeline/consolidation/geo";
import { startConsolidationRun } from "@/lib/pipeline/consolidation/run";
import {
  CONSOLIDATION_GEO_STAGE,
  CONSOLIDATION_STAGES,
  CONSOLIDATION_SUMMARY_STAGE,
  GEOMETRY_CONSOLIDATION_STAGES,
} from "@/lib/pipeline/consolidation/stages";
import { consolidateAfter } from "@/lib/pipeline/follow-ups";
import { generatePlaceImage, keyDone, type ImageView } from "@/lib/pipeline/images/generate";
import { setImageModelFactory } from "@/lib/pipeline/images/model";
import { imageJobs, imageTargets, nextViewSlot } from "@/lib/pipeline/images/stage";
import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";
import { startImageRun } from "@/lib/pipeline/images-run";
import { TEXT_RUN_STAGES } from "@/lib/pipeline/text/run";
import { chromiumInstalled } from "@/test/browser";
import { withRollback } from "@/test/db";
import {
  checker,
  GOOD,
  IMAGE_LAT,
  IMAGE_LON,
  imageModel,
  imageTasksOf,
  insertImageSubdivision,
  insertSpot,
  stubRender,
  syntheticImageryTransport,
} from "@/test/images";
import { memoryArchive } from "@/test/s3";

/*
 * Stage `images.place`: which places a run targets (plan), the run integration (the stage ends text, geometry and
 * consolidation runs) and one end-to-end run with the real renderer in headless Chromium.
 */

const cfg = getConfig();
/** The automatic title view: no zoom, the composition and the imagery choose it (`titleZoomFor`). */
const TITLE: ImageView = { slot: "title" };
const RENDER_TIMEOUT_MS = 180_000;

function recordingBoss() {
  const inserted: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const boss = {
    insert: async (queue: string, jobs: Array<{ id: string; data: Record<string, unknown> }>) => {
      inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
      return jobs.map((j) => j.id);
    },
  } as unknown as PgBoss;
  return { boss, inserted };
}

const withImages = (patch: Partial<AppConfig["images"]["pipeline"]>): AppConfig => ({
  ...cfg,
  images: { ...cfg.images, pipeline: { ...cfg.images.pipeline, ...patch } },
});

const withPromptVersion = (promptVersion: number): AppConfig => ({
  ...cfg,
  models: { ...cfg.models, imageTasks: { "generate-place-image": { ...cfg.models.imageTasks["generate-place-image"]!, promptVersion } } },
});

const withRulesVersion = (rulesVersion: string): AppConfig => ({
  ...cfg,
  images: { ...cfg.images, camera: { ...cfg.images.camera, rulesVersion } },
});

/** Kind, scope and stage names of run `id`. */
async function getRun(tx: Db, id: string) {
  const [row] = await tx
    .select({ kind: runs.kind, scopeType: runs.scopeType, scopeId: runs.scopeId, stages: runs.stages })
    .from(runs)
    .where(sql`${runs.id} = ${id}`);
  return row;
}

/** A run row of an image run over the subdivision `subdivisionKey` (the plan reads only its params). */
async function subdivisionRun(tx: Db, subdivisionKey: string) {
  const run = await createRun(tx, { kind: "stage", scope: { type: "subdivision", id: subdivisionKey }, stages: [IMAGES_STAGE], params: { images: { subdivisionKey } }, triggeredBy: "test" });
  return { id: run.id, params: { images: { subdivisionKey } } as Record<string, unknown> };
}

/**
 * Generates the title image of `objectId` once (stub renderer, `config` default the repo's, a green cadastre unless
 * `blankCadastre`), so its imagery and task exist.
 */
async function generateTitle(tx: Db, objectId: string, runId: string, force?: boolean, config?: AppConfig, blankCadastre = false) {
  await generatePlaceImage(
    tx,
    { geoObjectId: objectId, view: TITLE, runId, force },
    { archive: memoryArchive(), transport: await syntheticImageryTransport({ blankCadastre }), imageModel: await imageModel(GOOD), model: checker(false), render: stubRender, config },
  );
  const [task] = await imageTasksOf(tx, `${objectId}:title`);
  return task!;
}

/** The approved image of `task` as the current title image of the spot (what `approvePlaceImage` writes, reduced). */
async function insertApprovedTitle(tx: Db, objectId: string, task: Awaited<ReturnType<typeof generateTitle>>) {
  const c = task.context;
  await tx.insert(placeImages).values({
    geoObjectId: objectId, kind: "ai_illustration", slot: "title",
    cameraPosition: geomFromGeoJson({ type: "Point", coordinates: c.camera!.position }),
    cameraHeightM: c.camera!.heightM, viewBearingDeg: c.camera!.viewBearingDeg, cameraTiltDeg: c.camera!.tiltDeg, cameraFovDeg: c.camera!.fovDeg,
    renderId: c.renderId, fileKey: c.candidateKey!, width: 1536, height: 1024, alt: c.alt, generationKey: c.key,
  });
}

describe("imageTargets", () => {
  it("targets skip a place with the same generation key: open task", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const run = await subdivisionRun(tx, sd.key);
      expect(await imageTargets(tx, run)).toEqual([{ geoObjectId: spot.objectId, view: TITLE }]);
      await generateTitle(tx, spot.objectId, run.id);
      expect(await imageTargets(tx, run)).toEqual([]);
    });
  });

  it("plan and job agree on the key and zoom with a blank cadastre (z1) as with a fine one (z2)", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const fine = await insertSpot(tx, sd.id);
      const blank = await insertSpot(tx, sd.id, { lon: IMAGE_LON + 0.1 });
      const run = await subdivisionRun(tx, sd.key);
      expect((await imageTargets(tx, run)).map((t) => t.geoObjectId).sort()).toEqual([fine.objectId, blank.objectId].sort());
      const fineTask = await generateTitle(tx, fine.objectId, run.id);
      const blankTask = await generateTitle(tx, blank.objectId, run.id, undefined, undefined, true);
      expect(fineTask.context.zoom).toBe("z2");
      expect(blankTask.context.zoom).toBe("z1");
      // the plan reads the same zoom from the tiles the job stored, so both keys are done
      expect(await imageTargets(tx, run)).toEqual([]);
    });
  });

  it("targets skip a place with the same generation key: decided task", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const run = await subdivisionRun(tx, sd.key);
      const task = await generateTitle(tx, spot.objectId, run.id);
      await tx.execute(sql`update review_tasks set status = 'decided' where id = ${task.id}`);
      expect(await imageTargets(tx, run)).toEqual([]);
    });
  });

  it("targets skip a place with the same generation key: current place image", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const run = await subdivisionRun(tx, sd.key);
      const task = await generateTitle(tx, spot.objectId, run.id);
      await tx.execute(sql`update review_tasks set status = 'dismissed' where id = ${task.id}`);
      expect(await imageTargets(tx, run)).toHaveLength(1);
      const c = task.context;
      await tx.insert(placeImages).values({
        geoObjectId: spot.objectId,
        kind: "ai_illustration",
        slot: "title",
        cameraPosition: geomFromGeoJson({ type: "Point", coordinates: c.camera!.position }),
        cameraHeightM: c.camera!.heightM,
        viewBearingDeg: c.camera!.viewBearingDeg,
        cameraTiltDeg: c.camera!.tiltDeg,
        cameraFovDeg: c.camera!.fovDeg,
        renderId: c.renderId,
        fileKey: c.candidateKey!,
        width: 1536,
        height: 1024,
        alt: c.alt,
        generationKey: c.key,
      });
      expect(await imageTargets(tx, run)).toEqual([]);
    });
  });

  /** Decides `task` with `action` by writing the decision row and the status (the approval's image row is not made here). */
  async function decide(tx: Db, taskId: string, action: string) {
    await tx.insert(reviewDecisions).values({ taskId, decision: { action }, decidedBy: "test" });
    await tx.execute(sql`update review_tasks set status = 'decided' where id = ${taskId}`);
  }

  it("removed title image is a target again", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const run = await subdivisionRun(tx, sd.key);
      const task = await generateTitle(tx, spot.objectId, run.id);
      await decide(tx, task.id, "approve_image");
      // the approval's image is current: done
      await insertApprovedTitle(tx, spot.objectId, task);
      expect(await imageTargets(tx, run)).toEqual([]);
      // „Bild entfernen“ ends it
      await tx.execute(sql`update place_images set valid_to = current_date where geo_object_id = ${spot.objectId}`);
      expect(await imageTargets(tx, run)).toEqual([{ geoObjectId: spot.objectId, view: TITLE }]);
    });
  });

  it("removed title image is a target again after „Neu erzeugen“ at the same zoom, approval and removal (R19)", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const run = await subdivisionRun(tx, sd.key);
      // „Neu erzeugen“ at the same zoom: the first task is decided with the key, the forced run makes a second one
      const first = await generateTitle(tx, spot.objectId, run.id);
      await decide(tx, first.id, "regenerate_image");
      const second = await generateTitle(tx, spot.objectId, run.id, true);
      expect(second.id).not.toBe(first.id);
      expect(second.context.key).toBe(first.context.key);
      await decide(tx, second.id, "approve_image");
      await insertApprovedTitle(tx, spot.objectId, second);
      expect(await imageTargets(tx, run)).toEqual([]);
      // „Bild entfernen“: only the latest decision (the approval) counts, not the earlier „Neu erzeugen“
      await tx.execute(sql`update place_images set valid_to = current_date where geo_object_id = ${spot.objectId}`);
      expect(await keyDone(tx, spot.objectId, "title", second.context.key)).toBe(false);
      expect(await imageTargets(tx, run)).toEqual([{ geoObjectId: spot.objectId, view: TITLE }]);
      // a later „Kein Bild“ on a third task of the key makes it done again
      const third = await generateTitle(tx, spot.objectId, run.id);
      await decide(tx, third.id, "no_image");
      expect(await imageTargets(tx, run)).toEqual([]);
    });
  });

  it("removed further view is not regenerated", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const run = await subdivisionRun(tx, sd.key);
      const title = await generateTitle(tx, spot.objectId, run.id);
      await tx.execute(sql`update review_tasks set status = 'dismissed' where id = ${title.id}`);
      // a decided, approved task of a further view whose image was removed stays done
      await tx.execute(sql`update review_tasks set subject_id = ${`${spot.objectId}:view-2`} where id = ${title.id}`);
      await decide(tx, title.id, "approve_image");
      expect(await keyDone(tx, spot.objectId, "view-2", title.context.key!)).toBe(true);
      // and the automatic run only ever targets the title slot
      expect((await imageTargets(tx, run)).every((t) => t.view.slot === "title")).toBe(true);
    });
  });

  it("no_image still blocks", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const run = await subdivisionRun(tx, sd.key);
      const task = await generateTitle(tx, spot.objectId, run.id);
      await decide(tx, task.id, "no_image");
      expect(await imageTargets(tx, run)).toEqual([]);
    });
  });

  it("new prompt version makes the place a target again", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const run = await subdivisionRun(tx, sd.key);
      await generateTitle(tx, spot.objectId, run.id);
      expect(await imageTargets(tx, run)).toEqual([]);
      expect(await imageTargets(tx, run, withPromptVersion(2))).toEqual([{ geoObjectId: spot.objectId, view: TITLE }]);
    });
  });

  it("new camera rules version makes a place with an image under the old key a target again", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const run = await subdivisionRun(tx, sd.key);
      // the title image was generated and approved under the old camera rules
      const old = withRulesVersion("camera-1");
      const task = await generateTitle(tx, spot.objectId, run.id, undefined, old);
      await decide(tx, task.id, "approve_image");
      await insertApprovedTitle(tx, spot.objectId, task);
      expect(await imageTargets(tx, run, old)).toEqual([]);
      // the current rules give a new key: the title image is generated again (the old one stays until approval)
      expect(await imageTargets(tx, run)).toEqual([{ geoObjectId: spot.objectId, view: TITLE }]);
    });
  });

  it("without a usable image model (no key, or none set) the plan targets nothing", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      await insertSpot(tx, sd.id);
      const run = await subdivisionRun(tx, sd.key);
      expect(await imageTargets(tx, run)).toHaveLength(1);
      try {
        setImageModelFactory(() => new MockImageModel(() => new Error("unreachable"), { available: false }));
        expect(await imageTargets(tx, run)).toEqual([]);
        setImageModelFactory(undefined);
        expect(await imageTargets(tx, run)).toEqual([]);
      } finally {
        // what test/setup.ts set
        setImageModelFactory(() => new MockImageModel(() => new Error("the test must pass its own image model to generatePlaceImage")));
      }
      expect(await imageTargets(tx, run)).toHaveLength(1);
    });
  });

  it("place outside GR is no target", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx, "HR");
      await insertSpot(tx, sd.id);
      expect(await imageTargets(tx, await subdivisionRun(tx, sd.key))).toEqual([]);
    });
  });

  it("targets are capped at maxGenerationsPerRun", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      await insertSpot(tx, sd.id, { kind: "marina" });
      await insertSpot(tx, sd.id, { lon: IMAGE_LON + 0.05, kind: "port" });
      await insertSpot(tx, sd.id, { lat: IMAGE_LAT + 0.05, kind: "mooring_field" });
      const run = await subdivisionRun(tx, sd.key);
      expect(await imageTargets(tx, run)).toHaveLength(3);
      expect(await imageTargets(tx, run, withImages({ maxGenerationsPerRun: 2 }))).toHaveLength(2);
    });
  });

  it("confirmed place without fetch computation is no target; a candidate is none either", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      await insertSpot(tx, sd.id, { fetch: false });
      await insertSpot(tx, sd.id, { lon: IMAGE_LON + 0.05, status: "candidate" });
      const noAnchoring = await insertSpot(tx, sd.id, { lat: IMAGE_LAT + 0.05, status: "no_anchoring" });
      expect(await imageTargets(tx, await subdivisionRun(tx, sd.key))).toEqual([{ geoObjectId: noAnchoring.objectId, view: TITLE }]);
    });
  });
});

describe("image runs", () => {
  it("startImageRun for an additional view plans one job in the next free slot", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      expect(await nextViewSlot(tx, spot.objectId)).toBe("view-2");
      const view = { slot: "view-2", zoom: "z1" as const, azimuthDeg: 90 };
      const { boss, inserted } = recordingBoss();
      const { id } = await startImageRun(tx, boss, { geoObjectId: spot.objectId, view }, "admin");
      const run = await getRun(tx, id);
      expect(run).toMatchObject({ kind: "stage", scopeType: "place", scopeId: spot.placeId, stages: [IMAGES_STAGE] });
      expect(inserted).toEqual([{ queue: "images.place", data: expect.objectContaining({ geoObjectId: spot.objectId, view, runId: id, stage: IMAGES_STAGE }) }]);

      await createReviewTask(tx, { kind: "place_image", subjectType: "place_image", subjectId: `${spot.objectId}:view-2`, context: {} });
      expect(await nextViewSlot(tx, spot.objectId)).toBe("view-3");
    });
  });

  it("startImageRun over a subdivision plans its title images", async () => {
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const { boss, inserted } = recordingBoss();
      const { id } = await startImageRun(tx, boss, { subdivisionKey: sd.key }, "admin");
      expect(await getRun(tx, id)).toMatchObject({ scopeType: "subdivision", scopeId: sd.key, stages: [IMAGES_STAGE] });
      expect(inserted.map((j) => j.data.geoObjectId)).toEqual([spot.objectId]);
    });
  });

  it("text run, geometry run and consolidateAfter run list images.place last; regenerate_summary run does not", async () => {
    expect(CONSOLIDATION_STAGES.at(-1)).toBe(IMAGES_STAGE);
    expect(GEOMETRY_CONSOLIDATION_STAGES.at(-1)).toBe(IMAGES_STAGE);
    expect(TEXT_RUN_STAGES.at(-1)).toBe(IMAGES_STAGE);
    expect(STAGES[IMAGES_STAGE]).toMatchObject({ name: IMAGES_STAGE, queue: "images.place" });
    await withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const { boss } = recordingBoss();
      const after = await consolidateAfter(tx, async () => boss, { geoObjectIds: [spot.objectId], triggeredBy: "admin" });
      expect(after.status).toBe("started");
      const run = await getRun(tx, (after as { runId: string }).runId);
      expect(run!.stages.at(-1)).toBe(IMAGES_STAGE);

      const summary = await startConsolidationRun(tx, boss, { scope: { geoObjectIds: [spot.objectId] }, triggeredBy: "admin", stagesOnly: [CONSOLIDATION_SUMMARY_STAGE], regenerateSummary: true });
      expect((await getRun(tx, summary.id))!.stages).toEqual([CONSOLIDATION_SUMMARY_STAGE]);
    });
  });
});

describe.skipIf(!chromiumInstalled())("images.place end to end", () => {
  it(
    "newly confirmed marina gets a place_image task through its consolidation run",
    async () => {
      await withRollback(async (tx) => {
        const sd = await insertImageSubdivision(tx);
        const spot = await insertSpot(tx, sd.id, { status: "candidate" });
        const { id: taskId } = await createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId: spot.placeId, context: {} });
        const decided = await decideReviewTask(tx, { taskId, decision: { action: "confirm", kind: "marina" }, decidedBy: "admin" });
        expect(decided.consolidate?.geoObjectId).toBe(spot.objectId);

        const { boss } = recordingBoss();
        const after = await consolidateAfter(tx, async () => boss, { geoObjectIds: [spot.objectId], triggeredBy: "admin" });
        const runId = (after as { runId: string }).runId;
        const [row] = await tx.select({ stages: runs.stages, params: runs.params }).from(runs).where(sql`${runs.id} = ${runId}`);
        expect(row!.stages[0]).toBe(CONSOLIDATION_GEO_STAGE);
        expect(row!.stages.at(-1)).toBe(IMAGES_STAGE);
        const run = { id: runId, params: row!.params as Record<string, unknown> };

        // the stages in order, without the queue: consolidation first, then the image plan and its job
        for (const job of await consolidationGeoJobs(tx, run)) await consolidateGeoJob(tx, { ...job, runId });
        const jobs = await imageJobs(tx, run);
        expect(jobs).toEqual([{ key: `${spot.objectId}:title`, geoObjectId: spot.objectId, view: TITLE }]);

        const archive = memoryArchive();
        const result = await generatePlaceImage(
          tx,
          { geoObjectId: spot.objectId, view: TITLE, runId },
          { archive, transport: await syntheticImageryTransport(), imageModel: await imageModel(GOOD), model: checker(false) },
        );
        expect(result.status).toBe("review");
        const [task] = await imageTasksOf(tx, `${spot.objectId}:title`);
        expect(task!.context).toMatchObject({ slot: "title", light: "evening", attempts: result.attempts });
        expect(archive.keys()).toContain(task!.context.candidateKey);
        expect(archive.keys().some((k) => k.startsWith(`imagery/renders/${spot.objectId}/${task!.context.renderId}/`))).toBe(true);
      });
    },
    RENDER_TIMEOUT_MS,
  );
});
