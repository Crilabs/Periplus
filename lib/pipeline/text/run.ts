import type { PgBoss } from "pg-boss";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { RunScope } from "@/lib/domain/runs";
import { startRun } from "@/lib/pipeline/runs";
import { CLASSIFY_STAGE } from "./classify";
import { DISAMBIGUATE_STAGE } from "./disambiguate";
import { GEOCODE_STAGE } from "./geocode";
import { MENTIONS_STAGE } from "./mentions";
import { freezeTextRunParams, type TextRunParams } from "./versions";

/*
 * Starters of text runs (ruling M4-P1: only starters live here, no stage or handler imports this module). Task 17 adds
 * the remaining stages, the reprocess and the model comparison starters.
 */

/** The stages of a text run, in order (Task 17 appends extraction, routes and the check). */
export const TEXT_RUN_STAGES = [CLASSIFY_STAGE, MENTIONS_STAGE, DISAMBIGUATE_STAGE, GEOCODE_STAGE] as const;

function scopeOf(params: TextRunParams): RunScope {
  if (params.tileId) return { type: "tile", id: params.tileId };
  if (params.areaKey) return { type: "area", id: params.areaKey };
  return { type: "system", id: "texts" };
}

/**
 * Starts a text run over the selected versions. The selection is frozen at the start (ruling M4-E-R2): `pending`,
 * `tileId` and `areaKey` are resolved once into `params.documentVersionIds`, and every stage plans from that list,
 * so versions arriving mid-run wait for the next run.
 */
export async function startTextRun(
  db: Db,
  boss: PgBoss,
  input: TextRunParams & { triggeredBy: string },
  config: AppConfig = getConfig(),
): Promise<{ id: string }> {
  const { triggeredBy, ...selection } = input;
  const params = await freezeTextRunParams(db, selection, config);
  return startRun(db, boss, { kind: "stage", scope: scopeOf(selection), stages: [...TEXT_RUN_STAGES], params, triggeredBy });
}
