import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { DATASETS_STAGE, datasetKindsOf, type DatasetKind } from "@/lib/pipeline/datasets";
import { startRun } from "@/lib/pipeline/runs";
import { RunScopeNotReady, seedTileIds } from "@/lib/pipeline/tile-scope";

// Kept apart from ./datasets: the job handler imports that module, and this one reaches the stage registry
// through ./runs, which would close an import cycle through the handler.

/**
 * Starts the run "Datensätze laden" for a subdivision (scope `subdivision`, stage `datasets.import`, all kinds unless
 * `datasets` names some). Checked before the run exists: the subdivision exists (an area key fails with the
 * replacement hint) and already has coast tiles (its gazetteer run created them; else `RunScopeNotReady`), and
 * `datasets` lists known kinds.
 */
export async function startDatasetImportRun(
  db: Db,
  boss: PgBoss,
  subdivisionKey: string,
  triggeredBy: string,
  datasets?: DatasetKind[],
): Promise<{ id: string }> {
  await requireSubdivision(db, subdivisionKey);
  const params: Record<string, unknown> = datasets === undefined ? { subdivisionKey } : { subdivisionKey, datasets };
  datasetKindsOf(params);
  const coast = await seedTileIds(db, { subdivisionKey });
  if (coast.length === 0) {
    throw new RunScopeNotReady(
      "subdivision_without_coast_tiles",
      `Subdivision ${subdivisionKey} has no coast tiles yet; build its gazetteer first`,
    );
  }
  return startRun(db, boss, { kind: "stage", scope: { type: "subdivision", id: subdivisionKey }, stages: [DATASETS_STAGE], params, triggeredBy });
}
