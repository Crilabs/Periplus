import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { LAND_STAGE, ringCenters } from "@/lib/pipeline/gazetteer/land";
import { startRun } from "@/lib/pipeline/runs";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";

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

/**
 * Starts the run „Dinge an Land“ (stage `gazetteer.land`, N7 4.4) for a subdivision or for single candidates of it
 * (`placeIds`, e.g. ones the discovery added later). An unknown or excluded subdivision is rejected; a scope without
 * research candidates (`ringCenters` empty) throws `RunScopeNotReady("subdivision_without_candidates")`, both before
 * the run exists.
 */
export async function startLandRun(
  db: Db,
  boss: PgBoss,
  scope: { subdivisionKey: string } | { subdivisionKey: string; placeIds: string[] },
  triggeredBy: string,
): Promise<{ id: string }> {
  await requireSubdivision(db, scope.subdivisionKey);
  const centers = await ringCenters(db, "placeIds" in scope ? { placeIds: scope.placeIds } : { subdivisionKey: scope.subdivisionKey });
  if (centers.length === 0) {
    throw new RunScopeNotReady("subdivision_without_candidates", `No research candidates in ${scope.subdivisionKey}`);
  }
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "subdivision", id: scope.subdivisionKey },
    stages: [LAND_STAGE],
    params: { ...scope },
    triggeredBy,
  });
}
