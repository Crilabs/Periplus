import type { PgBoss } from "pg-boss";
import { areaByKey } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { DATASETS_STAGE, datasetKindsOf, type DatasetKind } from "@/lib/pipeline/datasets";
import { startRun } from "@/lib/pipeline/runs";
import { areaGeoObjectId, RunScopeNotReady, seedTileIds } from "@/lib/pipeline/tile-scope";

// Kept apart from ./datasets: the job handler imports that module, and this one reaches the stage registry
// through ./runs, which would close an import cycle through the handler.

/**
 * Starts the run "Datensätze laden" for an area (scope `area`, stage `datasets.import`, all kinds unless
 * `datasets` names some). Checked before the run exists: the area is configured and already has coast tiles
 * (its gazetteer run created them; else `RunScopeNotReady`), and `datasets` lists known kinds.
 */
export async function startDatasetImportRun(
  db: Db,
  boss: PgBoss,
  areaKey: string,
  triggeredBy: string,
  datasets?: DatasetKind[],
): Promise<{ id: string }> {
  areaByKey(areaKey);
  const params: Record<string, unknown> = datasets === undefined ? { areaKey } : { areaKey, datasets };
  datasetKindsOf(params);
  if (!(await areaGeoObjectId(db, areaKey))) {
    throw new RunScopeNotReady("area_without_geo_object", `Area ${areaKey} has no geo object yet; build its gazetteer first`);
  }
  const coast = await seedTileIds(db, { areaKey });
  if (coast.length === 0) {
    throw new RunScopeNotReady("area_without_coast_tiles", `Area ${areaKey} has no coast tiles yet; build its gazetteer first`);
  }
  return startRun(db, boss, { kind: "stage", scope: { type: "area", id: areaKey }, stages: [DATASETS_STAGE], params, triggeredBy });
}
