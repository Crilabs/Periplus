import type { PgBoss } from "pg-boss";
import { areaByKey } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { startRun } from "@/lib/pipeline/runs";

/** The stages of a gazetteer run for one area, in order (one job each). */
export const GAZETTEER_STAGES = [
  "tiles.ensure",
  "gazetteer.osm",
  "gazetteer.wikidata",
  "gazetteer.geonames",
  "gazetteer.hierarchy",
] as const;

/** Starts the run "build gazetteer" for an area; an area that is not configured is rejected before the run exists. */
export async function startGazetteerRun(db: Db, boss: PgBoss, areaKey: string, triggeredBy: string): Promise<{ id: string }> {
  areaByKey(areaKey);
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "area", id: areaKey },
    stages: [...GAZETTEER_STAGES],
    params: { areaKey },
    triggeredBy,
  });
}
