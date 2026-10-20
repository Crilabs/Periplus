import { z } from "zod";
import { getTransport } from "@/lib/adapters/http";
import type { ImageModel } from "@/lib/adapters/openai-image";
import { getArchive } from "@/lib/adapters/s3";
import { getConfig, type ZoomLevel } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { generatePlaceImage } from "@/lib/pipeline/images/generate";
import { imageJobs } from "@/lib/pipeline/images/stage";
import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { modelClientFor } from "./ai-batch";

type ImageModelFactory = (db: Db) => ImageModel;

let imageModelFactory: ImageModelFactory | undefined;

/** Sets how image jobs get their image model: the worker passes the OpenAI adapter, tests a `MockImageModel`. */
export function setImageModelFactory(factory: ImageModelFactory | undefined): void {
  imageModelFactory = factory;
}

/** The image model of image jobs; throws when the process never set one. */
export function imageModelFor(db: Db): ImageModel {
  if (!imageModelFactory) throw new Error("No image model configured for image jobs (setImageModelFactory)");
  return imageModelFactory(db);
}

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
    zoom: z.string().refine((z) => z in getConfig().images.camera.zooms, "unknown zoom level"),
    azimuthDeg: z.number().min(0).lt(360).optional(),
  }),
  runId: z.uuid(),
  /** „Neu erzeugen“ at the same zoom: a decided task with the key does not skip the job. */
  force: z.literal(true).optional(),
});

/** Generates one image of `data.geoObjectId` (`generatePlaceImage`) and puts it up for review. */
export const imagesPlaceHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = jobSchema.parse(data);
  const view = { ...job.view, zoom: job.view.zoom as ZoomLevel };
  const result = await generatePlaceImage(
    ctx.db,
    { geoObjectId: job.geoObjectId, view, runId: job.runId, force: job.force },
    { archive: getArchive(), transport: getTransport(), imageModel: imageModelFor(ctx.db), model: modelClientFor(ctx.db) },
  );
  ctx.log.info({ geoObjectId: job.geoObjectId, slot: view.slot, ...result }, "place image");
};
