import { z } from "zod";
import { getTransport } from "@/lib/adapters/http";
import { getArchive } from "@/lib/adapters/s3";
import { getConfig, type ZoomLevel } from "@/lib/config";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { generatePlaceImage, type ImageView } from "@/lib/pipeline/images/generate";
import { imageModelFor } from "@/lib/pipeline/images/model";
import { imageJobs } from "@/lib/pipeline/images/stage";
import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { modelClientFor } from "./ai-batch";

/** Stage `images.place`: one job per place and view to generate (`imageTargets`). */
export const imagesPlaceStage: StageDefinition = {
  name: IMAGES_STAGE,
  queue: "images.place",
  plan: imageJobs,
};

const jobSchema = z.object({
  geoObjectId: z.uuid(),
  view: z.object({
    slot: z.string().regex(/^(title|view-\d+)$/),
    /** An admin's zoom; the automatic title view has none (the composition and the imagery choose it). */
    zoom: z.string().refine((z) => z in getConfig().images.camera.zooms, "unknown zoom level").optional(),
    azimuthDeg: z.number().min(0).lt(360).optional(),
  }),
  runId: z.uuid(),
  /** „Neu erzeugen“ at the same zoom: a decided task with the key does not skip the job. */
  force: z.literal(true).optional(),
});

/** Generates one image of `data.geoObjectId` (`generatePlaceImage`) and puts it up for review. */
export const imagesPlaceHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = jobSchema.parse(data);
  const view: ImageView = {
    slot: job.view.slot,
    ...(job.view.zoom !== undefined ? { zoom: job.view.zoom as ZoomLevel } : {}),
    ...(job.view.azimuthDeg !== undefined ? { azimuthDeg: job.view.azimuthDeg } : {}),
  };
  const result = await generatePlaceImage(
    ctx.db,
    { geoObjectId: job.geoObjectId, view, runId: job.runId, force: job.force },
    { archive: getArchive(), transport: getTransport(), imageModel: imageModelFor(ctx.db), model: modelClientFor(ctx.db) },
  );
  ctx.log.info({ geoObjectId: job.geoObjectId, slot: view.slot, ...result }, "place image");
};
