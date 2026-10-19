import { and, asc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions, pipelinePasses } from "@/lib/db/schema";
import { MATCH_PASS_STAGE, mentionsConfigKey } from "@/lib/domain/mentions/store";

/*
 * Which document versions a text run works on (ruling M4-P1: kept apart from the run starters in `./run`, so stage
 * modules can import it without reaching `lib/pipeline/runs`). A text run freezes its version set when it starts
 * (ruling M4-E-R2): the starter resolves the selection (`pending`, `tileId`, `areaKey`, explicit ids) once into
 * `params.documentVersionIds`, and every stage plans from that frozen list (`frozenRunVersions`). Re-resolving
 * `pending` in a later stage would see nothing, because `mentions.batch` writes the passes that define it. Task 17
 * adds the reprocess, rematch and comparison selections.
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
 * - `tileId` / `areaKey`: the current versions of active documents with mentions of objects in that tile, or in the
 *   tiles of that area (`tile_geo_objects`);
 * - `pending`: the current versions of active documents the match has not passed with the current configuration
 *   (no `pipeline_passes` row for `mentions.batch` and `mentionsConfigKey(cfg)`).
 */
export async function textRunVersions(db: Db, params: TextRunParams, cfg: AppConfig): Promise<string[]> {
  const ids = new Set<string>();
  if (params.tileId || params.areaKey) for (const id of await scopedVersions(db, params)) ids.add(id);
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

/** Current versions of active documents with a mention of an object in the tile or in the tiles of the area. */
async function scopedVersions(db: Db, params: TextRunParams): Promise<string[]> {
  const tiles = params.tileId
    ? sql`select ${params.tileId}::text as id`
    : sql`select t.id from tiles t join geo_objects a on a.id = t.area_id and a.type = 'area'
          where a.config_key = ${params.areaKey!} and t.valid_from <= current_date and (t.valid_to is null or t.valid_to > current_date)`;
  const { rows } = await db.execute<{ id: string }>(sql`
    select distinct v.id
    from documents d
    join document_versions v on v.id = d.current_version_id
    join mentions m on m.document_version_id = v.id
    join tile_geo_objects tgo on tgo.geo_object_id = m.geo_object_id
    where d.status = 'active' and d.valid_to is null and tgo.tile_id in (${tiles})
  `);
  return rows.map((r) => r.id);
}

/** Run parameters with the version set frozen: the selection resolved once into `documentVersionIds` (ruling M4-E-R2). */
export type FrozenTextRunParams = TextRunParams & { documentVersionIds: string[] };

/**
 * Freezes a text run's version set at its start: resolves the selection (`textRunVersions`) into
 * `documentVersionIds`; the selection fields stay in the params as a record of what was asked for.
 */
export async function freezeTextRunParams(db: Db, params: TextRunParams, cfg: AppConfig): Promise<FrozenTextRunParams> {
  return { ...params, documentVersionIds: await textRunVersions(db, params, cfg) };
}

/**
 * The frozen version set of a text run, for stage planning (ruling M4-E-R2). Every text stage (Task 17 too: geocode,
 * extraction, routes, check) must plan from this list and never re-resolve `pending`/`tileId`/`areaKey`. A run
 * without a frozen list was not started by `freezeTextRunParams` and is an error of its starter.
 */
export async function frozenRunVersions(db: Db, params: Record<string, unknown>): Promise<string[]> {
  const parsed = textRunParamsSchema.parse(params);
  if (!parsed.documentVersionIds) throw new Error("text run has no frozen version set (params.documentVersionIds); start it with freezeTextRunParams");
  if (parsed.documentVersionIds.length === 0) return [];
  // Only versions that exist (a stale id in the params is skipped, not an error of the stage).
  const rows = await db
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(inArray(documentVersions.id, parsed.documentVersionIds))
    .orderBy(asc(documentVersions.id));
  return rows.map((r) => r.id);
}
