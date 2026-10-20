import { sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { planSubdivisions, planWarnings } from "@/lib/domain/subdivisions/plan";
import { applySubdivisionPlan, loadAdminUnits, subdivisionsWithoutLand, type SubdivisionApplyResult } from "@/lib/domain/subdivisions/store";
import { createLogger } from "@/lib/logger";

export const SUBDIVISIONS_STAGE = "subdivisions.build";

export type SubdivisionsBuildResult = SubdivisionApplyResult & { planned: number; warnings: string[] };

/**
 * Stage `subdivisions.build` (spec 14): plans the Landesteile from the coarse gazetteer and `config/subdivisions.json`
 * and applies the plan to the `subdivisions` table in one transaction (unbuilt rows are replaced, built ones only
 * reported, see `applySubdivisionPlan`). Configuration that matches nothing and deviations of built rows are logged as
 * warnings, not thrown. Needs land polygons for the Mediterranean (`npm run import:land-polygons -- --mediterranean`).
 */
export async function buildSubdivisions(db: Db, now: Date = new Date()): Promise<SubdivisionsBuildResult> {
  const cfg = getConfig().subdivisions;
  const log = createLogger("subdivisions.build");
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM land_polygons LIMIT 1) l`);
    if (rows[0]!.n === 0) throw new Error("land polygons missing – run npm run import:land-polygons -- --mediterranean");
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
