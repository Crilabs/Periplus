import { asc, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documentVersions } from "@/lib/db/schema";
import { areaOfSerpScopeSql } from "@/lib/domain/areas/store";
import { subdivisionTilesSql } from "@/lib/domain/gazetteer/tiles-ensure";
import { MATCH_PASS_STAGE, mentionsConfigKey } from "@/lib/domain/mentions/store";

/*
 * Which document versions a text run works on (ruling M4-P1: kept apart from the run starters in `./run`, so stage
 * modules can import it without reaching `lib/pipeline/runs`). A text run freezes its version set when it starts
 * (ruling M4-E-R2): the starter resolves the selection (`pending`, `tileId`, `subdivisionKey`, explicit ids) once into
 * `params.documentVersionIds`, and every stage plans from that frozen list (`frozenRunVersions`). Re-resolving
 * `pending` in a later stage would see nothing, because `mentions.batch` writes the passes that define it. `reprocess`
 * (every mention extracted again into a new extraction run) and `rematch` (new mentions after a review decision) only
 * change what the stages do with the frozen versions.
 */

export const textRunParamsSchema = z.object({
  documentVersionIds: z.array(z.string().uuid()).optional(),
  pending: z.literal(true).optional(),
  /** With `pending`: only the pending versions of these sources („Neue Texte auswerten“ on a source page, UI-10). */
  sourceIds: z.array(z.string().uuid()).optional(),
  tileId: z.string().optional(),
  /** The scope tiles of this subdivision (`subdivisionTileIds`); a run start with it must name a valid one. */
  subdivisionKey: z.string().optional(),
  /** A leftover area key: never a selection, the text run starter refuses it with the subdivision to use instead. */
  areaKey: z.string().optional(),
  reprocess: z.literal(true).optional(),
  rematch: z.literal(true).optional(),
  comparisonId: z.string().uuid().optional(),
  models: z.array(z.string()).optional(),
  /** The rules version the run's consolidation uses, frozen at the start (ruling M7-E-R1). */
  rulesVersion: z.string().min(1).optional(),
});

export type TextRunParams = z.infer<typeof textRunParamsSchema>;

/**
 * The versions of a text run, in id order and without duplicates:
 * - `documentVersionIds`: exactly these;
 * - `tileId` / `subdivisionKey`: the current versions of active documents with mentions of objects in that tile, or in
 *   the scope tiles of that subdivision (`tile_geo_objects`), plus the pending versions of the sources of that tile or
 *   subdivision (ruling M4-I-R0: sources found by a SERP search of the tile, of a scope tile, of an area touching one,
 *   or of a place in one), so a tile run
 *   also takes in what was fetched there and never matched; a reprocess or rematch run takes no pending versions (it
 *   works on what was matched before and ignores the passes);
 * - `pending`: the current versions of active documents the match has not passed with the current configuration
 *   (no `pipeline_passes` row for `mentions.batch` and `mentionsConfigKey(cfg)`), with `sourceIds` only those of
 *   these sources.
 */
export async function textRunVersions(db: Db, params: TextRunParams, cfg: AppConfig): Promise<string[]> {
  const ids = new Set<string>();
  if (params.tileId || params.subdivisionKey) {
    for (const id of await scopedVersions(db, params)) ids.add(id);
    if (!params.reprocess && !params.rematch) for (const id of await pendingVersions(db, cfg, params)) ids.add(id);
  }
  if (params.documentVersionIds && params.documentVersionIds.length > 0) {
    // Only versions that exist (a stale id in the params is skipped, not an error of the stage).
    const existing = await db
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(inArray(documentVersions.id, params.documentVersionIds));
    for (const r of existing) ids.add(r.id);
  }
  if (params.pending) for (const id of await pendingVersions(db, cfg, undefined, params.sourceIds)) ids.add(id);
  return [...ids].sort();
}

type Scope = Pick<TextRunParams, "tileId" | "subdivisionKey">;

/**
 * The tiles of a tile or subdivision selection (a query with one column): the tile itself, or the scope tiles of the
 * subdivision.
 */
export function scopeTiles(params: Scope) {
  if (params.tileId) return sql`select ${params.tileId}::text as id`;
  return subdivisionTilesSql(sql`(select id from subdivisions where key = ${params.subdivisionKey!} and valid_to is null)`);
}

/**
 * Current versions of active documents not passed by the match with the current configuration; with a tile or
 * subdivision selection only those of the sources a SERP search of that tile, of a scope tile, of an area touching one
 * or of a place in one of those tiles (ruling M5-P12) found; with `sourceIds` only those of these sources.
 */
async function pendingVersions(
  db: Db,
  cfg: AppConfig,
  scope?: Scope,
  sourceIds?: string[],
): Promise<string[]> {
  const sourceFilter = scope
    ? sql`and d.source_id in (${scopeSources(scope)})`
    : sourceIds
      ? sql`and d.source_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(sourceIds)}::jsonb))`
      : sql``;
  const { rows } = await db.execute<{ id: string }>(sql`
    select v.id
    from documents d
    join document_versions v on v.id = d.current_version_id
    where d.status = 'active' and d.valid_to is null ${sourceFilter}
      and not exists (
        select 1 from pipeline_passes p
        where p.document_version_id = v.id and p.stage = ${MATCH_PASS_STAGE} and p.config_key = ${mentionsConfigKey(cfg)}
      )
    order by v.id
  `);
  return rows.map((r) => r.id);
}

/**
 * The ids of the sources of a tile or subdivision selection (a query with one column): those a SERP search of that tile,
 * of a scope tile, of an area touching one (`tile_geo_objects`) or of a place in one of those tiles found (rulings
 * M4-I-R0, M5-P12).
 */
export function scopeSources(scope: Scope) {
  return sql`
        with st as (${scopeTiles(scope)}),
        sa as (
          select tgo.geo_object_id as id from tile_geo_objects tgo where tgo.tile_id in (select id from st)
        )
        select s.id from sources s
        join serp_results r on r.domain = s.domain
        join serp_queries q on q.id = r.serp_query_id
        where (q.level = 'tile' and q.scope_id in (select id from st))
          or (q.level = 'area' and ${areaOfSerpScopeSql(sql`q.scope_id`)} in (select id from sa))
          or (q.level = 'place' and exists (
            select 1 from places p
            where p.geo_object_id::text = q.scope_id and p.tile_id in (select id from st) and p.merged_into_id is null
              and p.valid_from <= current_date and (p.valid_to is null or p.valid_to > current_date)
          ))`;
}

/** Current versions of active documents with a mention of an object in the tile or in the scope tiles of the subdivision. */
async function scopedVersions(db: Db, params: TextRunParams): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    select distinct v.id
    from documents d
    join document_versions v on v.id = d.current_version_id
    join mentions m on m.document_version_id = v.id
    join tile_geo_objects tgo on tgo.geo_object_id = m.geo_object_id
    where d.status = 'active' and d.valid_to is null and tgo.tile_id in (${scopeTiles(params)})
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
 * extraction, routes, check) must plan from this list and never re-resolve `pending`/`tileId`/`subdivisionKey`. A run
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
