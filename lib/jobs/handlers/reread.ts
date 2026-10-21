import type { StageDefinition } from "@/lib/pipeline/runs";
import { REREAD_STAGE } from "@/lib/pipeline/text/reread";
import { subdivisionKeyOf } from "./tiles";

/** Stage `mentions.reread`: one job of a subdivision build that starts the re-read run and ends (the build does not wait). */
export const mentionsRereadStage: StageDefinition = {
  name: REREAD_STAGE,
  queue: "mentions.reread",
  async plan(_db, run) {
    const subdivisionKey = subdivisionKeyOf(run.params);
    return [{ key: subdivisionKey, subdivisionKey }];
  },
};
