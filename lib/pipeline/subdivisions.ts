import { sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { assignParents, assignSeas, assignSubdivisions } from "@/lib/domain/gazetteer/hierarchy";
import { planSubdivisions, planWarnings } from "@/lib/domain/subdivisions/plan";
import { applySubdivisionPlan, loadAdminUnits, subdivisionsWithoutLand, type SubdivisionApplyResult } from "@/lib/domain/subdivisions/store";
import { createLogger } from "@/lib/logger";
import { countryBbox } from "@/lib/pipeline/gazetteer/coarse";

export const SUBDIVISIONS_STAGE = "subdivisions.build";
/** Assigns the coarse objects of each country to subdivision, sea and parent; after `subdivisions.build`. */
export const SUBDIVISIONS_ASSIGN_STAGE = "subdivisions.assign";

/**
 * Configured countries without a valid country object (their `gazetteer.coarse` job failed or never ran). With a gap,
 * land at the border would go to the wrong subdivision (Gaza, B2), so the build refuses; a run with `countries` set
 * to these fetches them again.
 */
export class MissingCountries extends Error {
  constructor(readonly countries: string[]) {
    super(`coarse gazetteer lacks the countries ${countries.join(", ")} – start "Landesteile neu bilden" again with only these countries`);
    this.name = "MissingCountries";
  }
}

export type SubdivisionsBuildResult = SubdivisionApplyResult & { planned: number; warnings: string[] };

/**
 * Stage `subdivisions.build` (spec 14): plans the Landesteile from the coarse gazetteer and `config/subdivisions.json`
 * and applies the plan to the `subdivisions` table in one transaction (unbuilt rows are replaced, built ones only
 * reported, see `applySubdivisionPlan`). Configuration that matches nothing and deviations of built rows are logged as
 * warnings, not thrown. Needs land polygons for the Mediterranean (`npm run import:land-polygons -- --mediterranean`)
 * and a country object for every configured country (else `MissingCountries`).
 */
export async function buildSubdivisions(db: Db, now: Date = new Date()): Promise<SubdivisionsBuildResult> {
  const cfg = getConfig().subdivisions;
  const log = createLogger("subdivisions.build");
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM land_polygons LIMIT 1) l`);
    if (rows[0]!.n === 0) throw new Error("land polygons missing – run npm run import:land-polygons -- --mediterranean");
    const { rows: present } = await tx.execute<{ country: string }>(sql`
      SELECT DISTINCT tags->>'country' AS country FROM geo_objects
      WHERE type = 'country' AND valid_to IS NULL AND tags ? 'country'`);
    const have = new Set(present.map((r) => r.country));
    const missing = Object.keys(cfg.countries).filter((c) => !have.has(c)).sort();
    if (missing.length > 0) throw new MissingCountries(missing);
    const units = await loadAdminUnits(tx, cfg.mediterranean.marineRegionsMrgids);
    if (units.length === 0) throw new Error("coarse gazetteer is empty – run the stage gazetteer.coarse first");
    const plan = planSubdivisions(units, cfg);
    const withoutLand = await subdivisionsWithoutLand(tx, plan);
    if (withoutLand.length > 0) {
      throw new Error(
        `no land polygon intersects ${withoutLand.join(", ")} – run npx tsx scripts/import-land-polygons.ts --shp <land_polygons.shp> --mediterranean`,
      );
    }
    const warnings = planWarnings(units, cfg, plan);
    for (const w of warnings) log.warn({ warning: w }, "subdivisions config matches nothing");
    const applied = await applySubdivisionPlan(tx, plan, now.toISOString().slice(0, 10));
    for (const d of applied.deviations) log.warn(d, "built subdivision deviates from the plan");
    return { ...applied, planned: plan.length, warnings };
  });
}

/**
 * Stage `subdivisions.assign` for one country: subdivision, sea and parent of the valid objects whose centroid lies in
 * the country's box. Runs after `subdivisions.build`, so the subdivisions exist, and after `gazetteer.seas`, so the
 * seas do (B3, B14). Only changed values are written; a second call changes nothing.
 */
export async function assignCoarse(db: Db, country: string): Promise<{ subdivisions: number; seas: number; parents: number }> {
  const bbox = await countryBbox(db, country);
  if (!bbox) throw new Error(`subdivisions.assign ${country}: no country object – run gazetteer.coarse for it first`);
  return db.transaction(async (tx) => {
    const subdivisions = await assignSubdivisions(tx, bbox);
    const seas = await assignSeas(tx, bbox);
    const { updated: parents } = await assignParents(tx, bbox);
    return { subdivisions, seas, parents };
  });
}
