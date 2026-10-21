import type { ImageModel } from "@/lib/adapters/openai-image";
import type { Db } from "@/lib/db/client";
import { getEnv, type Env } from "@/lib/env";

/*
 * The image model of the image jobs (spec 13), set once per process: the worker passes the OpenAI adapter, tests a
 * `MockImageModel` (`test/setup.ts`). Kept apart from the job handler so the plan (`imageTargets`) can ask whether a
 * model is usable without importing the handler (which imports the plan).
 */

type ImageModelFactory = (db: Db) => ImageModel;

let imageModelFactory: ImageModelFactory | undefined;

/** Sets how image jobs get their image model; `undefined` removes it (a test of the no-key path). */
export function setImageModelFactory(factory: ImageModelFactory | undefined): void {
  imageModelFactory = factory;
}

/** The image model of image jobs; throws when the process never set one. */
export function imageModelFor(db: Db): ImageModel {
  if (!imageModelFactory) throw new Error("No image model configured for image jobs (setImageModelFactory)");
  return imageModelFactory(db);
}

/**
 * Whether the image jobs can paint, so a plan may target places: the model this process set (`ImageModel.available`:
 * the OpenAI adapter needs `OPENAI_API_KEY`, a test's mock always is) or, in a process without one (the Next.js
 * server plans the first stage of a run it starts; only the worker sets the adapter), the same condition as the
 * adapter's: `OPENAI_API_KEY` is set. Without either the plan targets nothing, so no run downloads imagery and renders
 * for an edit that cannot happen.
 */
export function imageModelAvailable(db: Db, env: Pick<Env, "OPENAI_API_KEY"> = getEnv()): boolean {
  if (imageModelFactory) return imageModelFactory(db).available();
  return env.OPENAI_API_KEY !== undefined;
}
