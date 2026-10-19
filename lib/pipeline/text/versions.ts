import { and, asc, eq, inArray, isNull, notExists } from "drizzle-orm";
import { z } from "zod";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions, pipelinePasses } from "@/lib/db/schema";
import { MATCH_PASS_STAGE, mentionsConfigKey } from "@/lib/domain/mentions/store";

/*
 * Which document versions a text run works on (ruling M4-P1: kept apart from the run starters in `./run`, so stage
 * modules can import it without reaching `lib/pipeline/runs`). Task 17 adds the tile, area, reprocess, rematch and
 * comparison selections.
 */

export const textRunParamsSchema = z.object({
  documentVersionIds: z.array(z.string().uuid()).optional(),
  pending: z.literal(true).optional(),
  tileId: z.string().optional(),
  areaKey: z.string().optional(),
  reprocess: z.literal(true).optional(),
  rematch: z.literal(true).optional(),
  comparisonId: z.string().uuid().optional(),
  models: z.array(z.string()).optional(),
});

export type TextRunParams = z.infer<typeof textRunParamsSchema>;

/**
 * The versions of a text run, in id order and without duplicates:
 * - `documentVersionIds`: exactly these;
 * - `pending`: the current versions of active documents the match has not passed with the current configuration
 *   (no `pipeline_passes` row for `mentions.batch` and `mentionsConfigKey(cfg)`).
 */
export async function textRunVersions(db: Db, params: TextRunParams, cfg: AppConfig): Promise<string[]> {
  const ids = new Set<string>();
  if (params.documentVersionIds && params.documentVersionIds.length > 0) {
    // Only versions that exist (a stale id in the params is skipped, not an error of the stage).
    const existing = await db
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(inArray(documentVersions.id, params.documentVersionIds));
    for (const r of existing) ids.add(r.id);
  }
  if (params.pending) {
    const rows = await db
      .select({ id: documentVersions.id })
      .from(documents)
      .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
      .where(
        and(
          eq(documents.status, "active"),
          isNull(documents.validTo),
          notExists(
            db
              .select({ one: pipelinePasses.stage })
              .from(pipelinePasses)
              .where(
                and(
                  eq(pipelinePasses.documentVersionId, documentVersions.id),
                  eq(pipelinePasses.stage, MATCH_PASS_STAGE),
                  eq(pipelinePasses.configKey, mentionsConfigKey(cfg)),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(documentVersions.id));
    for (const r of rows) ids.add(r.id);
  }
  return [...ids].sort();
}
