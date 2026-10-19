import { sql } from "drizzle-orm";
import { resolveTaskModel } from "@/lib/ai/cost";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";

/*
 * The active extraction run of a document version (consumed by M5): only its facts are consolidated. Facts of other
 * runs (an older model or prompt, a model comparison, a run whose Belegtreue is below 100 %) stay, but count nowhere.
 */

const EXTRACT_FACTS_TASK = "extract-facts";

/**
 * The youngest extraction run that is `finished` (its quote check passed), of task `extract-facts`, with the active
 * model, prompt version and fact schema version, not a model comparison, and with at least one `done` unit for the
 * version; null when there is none. A `blocked` or comparison run is never active.
 */
export async function activeExtractionRun(db: Db, documentVersionId: string, cfg: AppConfig = getConfig()): Promise<{ id: string } | null> {
  const { model, taskConfig } = resolveTaskModel(cfg, EXTRACT_FACTS_TASK);
  const { rows } = await db.execute<{ id: string }>(sql`
    select r.id from extraction_runs r
    where r.task = ${EXTRACT_FACTS_TASK} and r.status = 'finished' and r.purpose <> 'comparison'
      and r.model = ${model} and r.prompt_version = ${taskConfig.promptVersion} and r.fact_schema_version = ${cfg.factSchema.version}
      and exists (
        select 1 from extraction_units u
        where u.extraction_run_id = r.id and u.document_version_id = ${documentVersionId} and u.status = 'done'
      )
    order by r.started_at desc, r.id desc
    limit 1
  `);
  return rows[0] ? { id: rows[0].id } : null;
}
