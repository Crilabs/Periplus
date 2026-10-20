import { sql, type SQL } from "drizzle-orm";
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
 *
 * A model comparison run (purpose `comparison`) counts once the model decision is taken (NOTE T19, ruling M4-H-R3):
 * when `config/models.json` marks the `extract-facts` decision `decided`, the comparison run of the chosen model (the
 * configured one, with the active prompt and fact schema) is eligible like any regular run, so its facts need not be
 * paid for again; the run of the other model never matches the configured model and stays inactive, its facts stay.
 * While the decision is `provisional` no comparison run is active.
 */

const EXTRACT_FACTS_TASK = "extract-facts";

/**
 * The condition on `extraction_runs` alias `r` for a run whose facts may be active: `extract-facts`, `finished` (its
 * quote check passed), the active model, prompt version and fact schema version, and not a comparison run unless the
 * model decision is taken.
 */
export function eligibleRunSql(cfg: AppConfig): SQL {
  const { model, taskConfig } = resolveTaskModel(cfg, EXTRACT_FACTS_TASK);
  const decided = taskConfig.decision?.status === "decided";
  return sql`r.task = ${EXTRACT_FACTS_TASK} and r.status = 'finished' and (r.purpose <> 'comparison' or ${decided})
    and r.model = ${model} and r.prompt_version = ${taskConfig.promptVersion} and r.fact_schema_version = ${cfg.factSchema.version}`;
}

/**
 * The youngest extraction run that is `finished` (its quote check passed), of task `extract-facts`, with the active
 * model, prompt version and fact schema version, not a model comparison (unless the decision is taken, see above), and
 * with at least one `done` unit for the version and geo object; null when there is none. A `blocked` run is never
 * active.
 */
export async function activeExtractionRun(
  db: Db,
  documentVersionId: string,
  geoObjectId: string,
  cfg: AppConfig = getConfig(),
): Promise<{ id: string } | null> {
  const { rows } = await db.execute<{ id: string | null }>(
    sql`select ${activeExtractionRunIdSql(cfg, sql`${documentVersionId}::uuid`, sql`${geoObjectId}::uuid`)} as id`,
  );
  return rows[0]?.id ? { id: rows[0].id } : null;
}

/**
 * The id of the active run (`activeExtractionRun`) of the (version, object) given as SQL expressions, null without
 * one: a scalar subquery for set-based queries (the shelter metric, ruling M7-C-R2).
 */
export function activeExtractionRunIdSql(cfg: AppConfig, documentVersionId: SQL, geoObjectId: SQL): SQL {
  return sql`(
    select r.id from extraction_runs r
    where ${eligibleRunSql(cfg)}
      and exists (
        select 1 from extraction_units u
        where u.extraction_run_id = r.id and u.document_version_id = ${documentVersionId} and u.geo_object_id = ${geoObjectId}
          and u.status = 'done'
      )
    order by r.started_at desc, r.id desc
    limit 1
  )`;
}

/**
 * Of the given mentions, those a done unit of an eligible extraction run (`eligibleRunSql`) has extracted already: a
 * regular run leaves them alone (fold-in of the bundle I review). A reprocess run's match may add mentions, which its
 * own extraction then covers (it takes every mention of its versions) without claiming them; the next regular run
 * must not pay for them again. Mentions no such unit holds (a rematch's new names) are extracted as usual.
 */
export async function mentionsExtractedBefore(db: Db, mentionIds: string[], cfg: AppConfig = getConfig()): Promise<string[]> {
  if (mentionIds.length === 0) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    select m.id from mentions m
    where m.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(mentionIds)}::jsonb))
      and exists (
        select 1 from extraction_runs r join extraction_units u on u.extraction_run_id = r.id
        where ${eligibleRunSql(cfg)} and u.status = 'done' and m.id = any(u.mention_ids)
      )
    order by m.id
  `);
  return rows.map((r) => r.id);
}
