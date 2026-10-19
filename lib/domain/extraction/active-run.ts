import { sql } from "drizzle-orm";
import { resolveTaskModel } from "@/lib/ai/cost";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";

/*
 * The active extraction run of a (document version, geo object) (consumed by M5): only its facts about the object are
 * consolidated. Facts of other runs (an older model or prompt, a model comparison, a run whose Belegtreue is below
 * 100 %) stay, but count nowhere.
 *
 * Why per geo object and not per version (ruling M4-H-R2, overriding the plan text): a run extracts only the units it
 * claims. A rematch run after a review decision extracts just the newly confirmed object of a version, and a run whose
 * unit for one object failed has done units for the others only. Resolved per version, such a run would replace an
 * older run for every object of the version and silently drop the older facts of all objects it never extracted. Spec
 * 06 "Facts des nicht gewählten Laufs bleiben, werden nicht konsolidiert" is a choice per unit, and the unit is
 * (version, geo object).
 */

const EXTRACT_FACTS_TASK = "extract-facts";

/**
 * The youngest extraction run that is `finished` (its quote check passed), of task `extract-facts`, with the active
 * model, prompt version and fact schema version, not a model comparison, and with at least one `done` unit for the
 * version and geo object; null when there is none. A `blocked` or comparison run is never active.
 */
export async function activeExtractionRun(
  db: Db,
  documentVersionId: string,
  geoObjectId: string,
  cfg: AppConfig = getConfig(),
): Promise<{ id: string } | null> {
  const { model, taskConfig } = resolveTaskModel(cfg, EXTRACT_FACTS_TASK);
  const { rows } = await db.execute<{ id: string }>(sql`
    select r.id from extraction_runs r
    where r.task = ${EXTRACT_FACTS_TASK} and r.status = 'finished' and r.purpose <> 'comparison'
      and r.model = ${model} and r.prompt_version = ${taskConfig.promptVersion} and r.fact_schema_version = ${cfg.factSchema.version}
      and exists (
        select 1 from extraction_units u
        where u.extraction_run_id = r.id and u.document_version_id = ${documentVersionId} and u.geo_object_id = ${geoObjectId}
          and u.status = 'done'
      )
    order by r.started_at desc, r.id desc
    limit 1
  `);
  return rows[0] ? { id: rows[0].id } : null;
}
