import { sql } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { textRunVersions } from "@/lib/pipeline/text/versions";

/** How many of the newest finished extraction runs the cost per mention is averaged over. */
export const ESTIMATE_RUNS = 5;

export type ReprocessEstimate = { mentions: number; costPerMentionEur: number | null; estimateEur: number | null };

/**
 * The cost estimate of „Reprozessieren für Landesteil“ (spec 17 „Einführung“): the mentions a reprocess run of the
 * subdivision would extract again (every mention of the versions `textRunVersions` selects for it) times the mean
 * `stats.costPerMentionEur` of the last `ESTIMATE_RUNS` finished regular or reprocess extraction runs of the facts task
 * that have it. Without such a run there is no cost per mention and no estimate. The follow-up discovery and the image
 * downloads of the run are not part of it.
 */
export async function estimateReprocessCostEur(db: Db, subdivisionKey: string, cfg: AppConfig): Promise<ReprocessEstimate> {
  const versionIds = await textRunVersions(db, { subdivisionKey, reprocess: true }, cfg);
  const mentions =
    versionIds.length === 0
      ? 0
      : Number(
          (
            await db.execute<{ n: number }>(sql`
              select count(*)::int as n from mentions
              where document_version_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(versionIds)}::jsonb))
            `)
          ).rows[0]!.n,
        );
  const { rows } = await db.execute<{ cost: number }>(sql`
    select (stats->>'costPerMentionEur')::float8 as cost
    from extraction_runs
    where task = 'extract-facts' and status = 'finished' and purpose in ('regular', 'reprocess') and stats->>'costPerMentionEur' is not null
    order by finished_at desc nulls last, id desc
    limit ${ESTIMATE_RUNS}
  `);
  if (rows.length === 0) return { mentions, costPerMentionEur: null, estimateEur: null };
  const costPerMentionEur = rows.reduce((sum, r) => sum + Number(r.cost), 0) / rows.length;
  return { mentions, costPerMentionEur, estimateEur: mentions * costPerMentionEur };
}
