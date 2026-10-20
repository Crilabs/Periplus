import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { startRun } from "@/lib/pipeline/runs";

/** The stages of a gazetteer run for one subdivision, in order (one job each). */
export const GAZETTEER_STAGES = [
  "tiles.ensure",
  "gazetteer.osm",
  "gazetteer.wikidata",
  "gazetteer.geonames",
  "gazetteer.hierarchy",
] as const;

/**
 * Starts the run "build gazetteer" for a subdivision; an unknown or excluded subdivision is rejected before the run
 * exists.
 */
export async function startGazetteerRun(db: Db, boss: PgBoss, subdivisionKey: string, triggeredBy: string): Promise<{ id: string }> {
  await requireSubdivision(db, subdivisionKey);
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "subdivision", id: subdivisionKey },
    stages: [...GAZETTEER_STAGES],
    params: { subdivisionKey },
    triggeredBy,
  });
}
