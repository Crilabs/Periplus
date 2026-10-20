import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { COARSE_STAGE } from "@/lib/pipeline/gazetteer/coarse";
import { startRun } from "@/lib/pipeline/runs";
import { SUBDIVISIONS_STAGE } from "@/lib/pipeline/subdivisions";

export const SUBDIVISIONS_SCOPE = "subdivisions";

/** The stages of the run "build subdivisions": the coarse gazetteer, then the Landesteil list computed from it. */
export const SUBDIVISIONS_STAGES = [COARSE_STAGE, SUBDIVISIONS_STAGE] as const;

/** Starts the system run that imports the coarse gazetteer and builds the Landesteile. */
export async function startSubdivisionsBuildRun(db: Db, boss: PgBoss, triggeredBy: string): Promise<{ id: string }> {
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "system", id: SUBDIVISIONS_SCOPE },
    stages: [...SUBDIVISIONS_STAGES],
    triggeredBy,
  });
}
