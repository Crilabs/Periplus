import type { Db } from "@/lib/db/client";
import { subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { parseTileId } from "@/lib/domain/tiles";

// No import of ./runs here: modules a job handler imports must not reach the stage registry (import cycle).

/** Why a run's scope is not ready for its stage; the admin UI shows a German text per reason. */
export type RunScopeReason =
  | "area_without_geo_object"
  | "area_without_coast_tiles"
  | "subdivision_without_coast_tiles"
  | "tile_without_subdivision"
  | "bathymetry_missing"
  | "land_missing"
  | "place_not_computable"
  | "no_approved_sources"
  | "source_not_approved"
  | "source_run_active"
  | "wikivoyage_source_ended"
  | "document_not_upload"
  | "no_converter_samples"
  | "converter_samples_done"
  | "comparison_run_active"
  | "embed_backfill_active"
  | "unknown_tile"
  | "unknown_area"
  | "versions_not_current"
  | "unknown_comparison"
  | "comparison_without_units"
  | "comparison_started"
  | "comparison_over_budget"
  | "geo_object_not_consolidatable"
  | "comparison_set_empty"
  | "geo_object_without_place"
  | "measurement_label_taken"
  | "measurement_label_invalid"
  | "measurement_window_empty"
  | "measurement_from_required"
  | "measurement_running"
  | "evaluation_candidate_missing"
  | "evaluation_candidate_unknown";

/** A run start refused before the run exists because its scope lacks an input (an expected, user-facing error). */
export class RunScopeNotReady extends Error {
  constructor(
    readonly reason: RunScopeReason,
    message: string,
  ) {
    super(message);
    this.name = "RunScopeNotReady";
  }
}

/** Stage of the seed run; here rather than in ./seed, which imports ./runs. */
export const SEED_STAGE = "seed.tile";

/**
 * The tiles a seed run covers: `params.tileIds` exactly as given, else every valid coast tile whose box meets the
 * subdivision `params.subdivisionKey` (ordered by id; border tiles belong to both neighbours). Throws for invalid
 * params, an unknown subdivision, or a leftover area key.
 */
export async function seedTileIds(db: Db, params: Record<string, unknown>): Promise<string[]> {
  if (Array.isArray(params.tileIds)) {
    for (const id of params.tileIds) {
      if (typeof id !== "string") throw new Error("tileIds must be strings");
      parseTileId(id);
    }
    return params.tileIds as string[];
  }
  if (typeof params.areaKey === "string" && params.areaKey !== "") {
    throw new Error(`Revier-Schlüssel ${params.areaKey} ist kein Laufumfang mehr; Landesteil angeben (z. B. GR-I)`);
  }
  if (typeof params.subdivisionKey !== "string" || params.subdivisionKey === "") {
    throw new Error("tileIds or subdivisionKey is required");
  }
  const sub = await requireSubdivision(db, params.subdivisionKey);
  return subdivisionTileIds(db, sub.id);
}
