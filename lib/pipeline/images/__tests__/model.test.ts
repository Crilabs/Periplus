import { describe, expect, it } from "vitest";
import { MockImageModel } from "@/lib/ai/mock-image";
import { createRun } from "@/lib/domain/runs";
import { imageModelAvailable, setImageModelFactory } from "@/lib/pipeline/images/model";
import { imageTargets } from "@/lib/pipeline/images/stage";
import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";
import { withRollback } from "@/test/db";
import { insertImageSubdivision, insertSpot } from "@/test/images";

/*
 * Whether image jobs can paint (`imageModelAvailable`), as the plan of an image run asks it: in the worker through the
 * model it set, in the Next.js server (which plans the first stage of a run it starts, with no model set) through
 * `OPENAI_API_KEY`. The env goes in explicitly (`getEnv` is memoized), the model factory is unset and restored.
 */

const WITH_KEY = { OPENAI_API_KEY: "sk-test" };
const NO_KEY = { OPENAI_API_KEY: undefined };

/** What test/setup.ts set: a process with a usable model. */
const restoreTestModel = () => setImageModelFactory(() => new MockImageModel(() => new Error("the test must pass its own image model to generatePlaceImage")));

describe("imageModelAvailable", () => {
  it("without a model set (the Next.js server) the key decides whether a run plans images; a set model decides itself", () =>
    withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      await insertSpot(tx, sd.id);
      const run = await createRun(tx, { kind: "stage", scope: { type: "subdivision", id: sd.key }, stages: [IMAGES_STAGE], params: { images: { subdivisionKey: sd.key } }, triggeredBy: "test" });
      const plan = { id: run.id, params: { images: { subdivisionKey: sd.key } } as Record<string, unknown> };
      try {
        // no model set, no key: nothing planned
        setImageModelFactory(undefined);
        expect(imageModelAvailable(tx, NO_KEY)).toBe(false);
        expect(await imageTargets(tx, plan, undefined, NO_KEY)).toEqual([]);
        // no model set, the key present (an admin starts „Titelbilder erzeugen“ in the web process): the run plans its jobs
        expect(imageModelAvailable(tx, WITH_KEY)).toBe(true);
        expect(await imageTargets(tx, plan, undefined, WITH_KEY)).toHaveLength(1);
        // a model set in this process decides itself, whatever the key says
        setImageModelFactory(() => new MockImageModel(() => new Error("unreachable"), { available: false }));
        expect(imageModelAvailable(tx, WITH_KEY)).toBe(false);
        expect(await imageTargets(tx, plan, undefined, WITH_KEY)).toEqual([]);
        setImageModelFactory(() => new MockImageModel(() => new Error("unreachable")));
        expect(imageModelAvailable(tx, NO_KEY)).toBe(true);
        expect(await imageTargets(tx, plan, undefined, NO_KEY)).toHaveLength(1);
      } finally {
        restoreTestModel();
      }
    }));
});
