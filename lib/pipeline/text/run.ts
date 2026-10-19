import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { RunScope } from "@/lib/domain/runs";
import { startRun } from "@/lib/pipeline/runs";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { CHECK_STAGE } from "./check";
import { CLASSIFY_STAGE } from "./classify";
import { DISAMBIGUATE_STAGE } from "./disambiguate";
import { EXTRACT_STAGE } from "./extract";
import { GEOCODE_STAGE } from "./geocode";
import { MENTIONS_STAGE } from "./mentions";
import { ROUTE_STAGE } from "./routes";
import { freezeTextRunParams, type TextRunParams } from "./versions";

/*
 * Starters of text runs (ruling M4-P1: only starters live here, no stage or handler imports this module): "Texte
 * auswerten" (`startTextRun`: pending versions, a tile or area, or given versions, also the rematch after a review
 * decision) and "Reprozessieren" (`startReprocessRun`). Task 19 adds the model comparison starter.
 */

/** The stages of a text run, in order; the quote check (`extraction.check`) comes last. */
export const TEXT_RUN_STAGES = [CLASSIFY_STAGE, MENTIONS_STAGE, DISAMBIGUATE_STAGE, GEOCODE_STAGE, EXTRACT_STAGE, ROUTE_STAGE, CHECK_STAGE] as const;

function scopeOf(params: TextRunParams): RunScope {
  if (params.tileId) return { type: "tile", id: params.tileId };
  if (params.areaKey) return { type: "area", id: params.areaKey };
  return { type: "system", id: "texts" };
}

/**
 * Refuses a text run whose selection cannot be worked on, before the run exists (ruling M4-P16): a tile that is not a
 * valid tile, an area that is not configured or has no valid tile, given versions that do not exist or are no longer
 * the current version of their document. A `pending` selection with nothing to do still starts (its stages finish at
 * once).
 */
async function assertSelectionReady(db: Db, params: TextRunParams, config: AppConfig): Promise<void> {
  if (params.tileId) {
    const { rows } = await db.execute(sql`
      select 1 from tiles t where t.id = ${params.tileId} and t.valid_from <= current_date and (t.valid_to is null or t.valid_to > current_date)
    `);
    if (rows.length === 0) throw new RunScopeNotReady("unknown_tile", `tile ${params.tileId} is not a valid tile`);
  }
  if (params.areaKey) {
    if (!config.areas.some((a) => a.key === params.areaKey)) {
      throw new RunScopeNotReady("unknown_area", `area ${params.areaKey} is not configured`);
    }
    const { rows } = await db.execute(sql`
      select 1 from tiles t join geo_objects a on a.id = t.area_id and a.type = 'area'
      where a.config_key = ${params.areaKey} and t.valid_from <= current_date and (t.valid_to is null or t.valid_to > current_date)
      limit 1
    `);
    if (rows.length === 0) throw new RunScopeNotReady("area_without_tiles", `area ${params.areaKey} has no tiles yet`);
  }
  const ids = params.documentVersionIds ?? [];
  if (ids.length > 0) {
    const { rows } = await db.execute<{ id: string }>(sql`
      select v.id from document_versions v join documents d on d.current_version_id = v.id
      where v.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
    `);
    if (new Set(rows.map((r) => r.id)).size < new Set(ids).size) {
      throw new RunScopeNotReady("versions_not_current", "a given document version does not exist or is not current");
    }
  }
}

/**
 * Starts a text run ("Texte auswerten", kind `stage`, every text stage) over the selected versions. The selection is
 * checked first (`RunScopeNotReady`) and frozen at the start (ruling M4-E-R2): `pending`, `tileId` and `areaKey` are
 * resolved once into `params.documentVersionIds`, and every stage plans from that list, so versions arriving mid-run
 * wait for the next run. `rematch: true` (after a review decision named a new object) matches the versions again;
 * only the mentions this creates are pending, so only they are extracted.
 */
export async function startTextRun(
  db: Db,
  boss: PgBoss,
  input: TextRunParams & { triggeredBy: string },
  config: AppConfig = getConfig(),
): Promise<{ id: string }> {
  const { triggeredBy, ...selection } = input;
  await assertSelectionReady(db, selection, config);
  const params = await freezeTextRunParams(db, selection, config);
  return startRun(db, boss, { kind: "stage", scope: scopeOf(selection), stages: [...TEXT_RUN_STAGES], params, triggeredBy });
}

/**
 * Starts "Reprozessieren" for a tile or an area (spec 06, Reprozessierung: kind `reprocess`, every text stage,
 * `params.reprocess`): the versions with mentions there are matched again (adding nothing that exists), and every one
 * of their mentions is extracted again into a new extraction run with the configured model, prompt and fact schema;
 * the old facts stay. Pending versions are not taken in (a reprocess ignores the passes).
 */
export async function startReprocessRun(
  db: Db,
  boss: PgBoss,
  input: { scope: { tileId: string } | { areaKey: string }; triggeredBy: string },
  config: AppConfig = getConfig(),
): Promise<{ id: string }> {
  const selection: TextRunParams = { ...input.scope, reprocess: true };
  await assertSelectionReady(db, selection, config);
  const params = await freezeTextRunParams(db, selection, config);
  return startRun(db, boss, { kind: "reprocess", scope: scopeOf(selection), stages: [...TEXT_RUN_STAGES], params, triggeredBy: input.triggeredBy });
}
