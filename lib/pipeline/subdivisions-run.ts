import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { getConfig } from "@/lib/config";
import { COARSE_STAGE, SEAS_STAGE } from "@/lib/pipeline/gazetteer/coarse";
import { startRun } from "@/lib/pipeline/runs";
import { SUBDIVISIONS_ASSIGN_STAGE, SUBDIVISIONS_STAGE } from "@/lib/pipeline/subdivisions";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";

export const SUBDIVISIONS_SCOPE = "subdivisions";

/**
 * The stages of the run "build subdivisions" in their real order (B3, B14): the IHO seas, the coarse gazetteer per
 * country, the Landesteil list computed from it, then the assignment of the coarse objects to subdivision, sea and parent.
 */
export const SUBDIVISIONS_STAGES = [SEAS_STAGE, COARSE_STAGE, SUBDIVISIONS_STAGE, SUBDIVISIONS_ASSIGN_STAGE] as const;

/**
 * Starts the system run that imports the coarse gazetteer and builds the Landesteile. `countries` limits
 * `gazetteer.coarse` to those (a country that failed before); `subdivisions.build` still checks all. Refused before the
 * run exists for an unconfigured country (`unknown_country`) and when no land polygons are imported (`land_missing`):
 * the coarse towns and the build need them.
 */
export async function startSubdivisionsBuildRun(
  db: Db,
  boss: PgBoss,
  triggeredBy: string,
  opts: { countries?: string[] } = {},
): Promise<{ id: string }> {
  const configured = getConfig().subdivisions.countries;
  const unknown = (opts.countries ?? []).filter((c) => !Object.hasOwn(configured, c));
  if (unknown.length > 0) throw new RunScopeNotReady("unknown_country", `unknown countries: ${unknown.join(", ")}`);
  const params = opts.countries?.length ? { countries: [...new Set(opts.countries)] } : {};
  const { rows } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM land_polygons LIMIT 1) l`);
  if (rows[0]!.n === 0) {
    throw new RunScopeNotReady("land_missing", "land polygons missing – run npm run import:land-polygons -- --mediterranean first");
  }
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "system", id: SUBDIVISIONS_SCOPE },
    stages: [...SUBDIVISIONS_STAGES],
    params,
    triggeredBy,
  });
}
