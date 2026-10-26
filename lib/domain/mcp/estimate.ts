import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { DATASETS_STAGE } from "@/lib/pipeline/datasets";
import { DELIVERY_STAGE } from "@/lib/pipeline/delivery";
import { GAZETTEER_STAGES } from "@/lib/pipeline/gazetteer/stages";
import { GEOMETRY_RUN_STAGES } from "@/lib/pipeline/geometry-run";
import { pendingImageSpotCount } from "@/lib/pipeline/images/stage";
import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";
import { researchCandidates } from "@/lib/domain/research/candidates";
import { RESEARCH_STAGES } from "@/lib/pipeline/research-run";
import { SUBDIVISION_BUILD_STAGES } from "@/lib/pipeline/subdivision-build";
import { SUBDIVISIONS_STAGES } from "@/lib/pipeline/subdivisions-run";
import { SEED_STAGE } from "@/lib/pipeline/tile-scope";

export type ScopeUnit = "places" | "tiles" | "subdivision";
export type ScopeSize = { unit: ScopeUnit; count: number };

export type StartKind = "subdivisions" | "build" | "gazetteer" | "seed" | "datasets" | "geometry" | "research" | "images" | "delivery";

/** What a start tool is given to scope a run: a subdivision, one tile or a list of places. */
export type StartScope = { subdivisionKey: string } | { tileId: string } | { placeIds: string[] } | Record<string, never>;

/**
 * The `runs.stages` each starter stores. A geometry run for one place skips `geometry.detect_bays`; its stages then
 * differ from this list (geometry is costless, so no estimate looks it up).
 */
export const STAGES_OF: Record<StartKind, readonly string[]> = {
  subdivisions: SUBDIVISIONS_STAGES,
  build: SUBDIVISION_BUILD_STAGES,
  gazetteer: GAZETTEER_STAGES,
  seed: [SEED_STAGE],
  datasets: [DATASETS_STAGE],
  geometry: GEOMETRY_RUN_STAGES,
  research: RESEARCH_STAGES,
  images: [IMAGES_STAGE],
  delivery: [DELIVERY_STAGE],
};

/** Kinds whose runs call no paid service. */
export const COSTLESS: ReadonlySet<StartKind> = new Set<StartKind>(["subdivisions", "gazetteer", "seed", "geometry"]);

/** The size of the run `kind` would start for `scope`, in the unit its cost scales with. */
export async function scopeSize(db: Db, kind: StartKind, scope: StartScope): Promise<ScopeSize> {
  if (kind === "subdivisions") return { unit: "subdivision", count: 0 };
  if (kind === "delivery") return { unit: "subdivision", count: 1 };
  if (kind === "research") {
    if ("tileId" in scope) throw new Error("A research run takes a subdivision or places, not a tile");
    return { unit: "places", count: (await researchCandidates(db, scope)).length };
  }
  if (kind === "images") {
    if (!("subdivisionKey" in scope)) throw new Error("An image run takes a subdivision");
    return { unit: "places", count: await pendingImageSpotCount(db, scope.subdivisionKey) };
  }
  if ("tileId" in scope) return { unit: "tiles", count: 1 };
  if ("placeIds" in scope) {
    if (kind !== "geometry") throw new Error(`A ${kind} run takes a subdivision or a tile, not places`);
    return { unit: "places", count: scope.placeIds.length };
  }
  const sub = await requireSubdivision(db, scope.subdivisionKey);
  return { unit: "tiles", count: (await subdivisionTileIds(db, sub.id)).length };
}

export type CostEstimate = {
  eur: number | null;
  basis: { runId: string; costEur: number; size: ScopeSize } | null;
  text: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The cost of a run of `size`, scaled from the last finished run of the same stages and unit (`params.scopeSize`,
 * `recordScopeSize`): its summed `external_calls` per unit times `size.count`. Without such a run no number.
 */
export async function estimateCost(db: Db, kind: StartKind, size: ScopeSize): Promise<CostEstimate> {
  if (COSTLESS.has(kind)) return { eur: 0, basis: null, text: "ohne externe Kosten" };
  const stages = `{${STAGES_OF[kind].join(",")}}`;
  const { rows } = await db.execute<{ id: string; count: string; cost: string }>(sql`
    select r.id, r.params -> 'scopeSize' ->> 'count' as count,
      coalesce((select sum(c.cost_eur) from external_calls c where c.run_id = r.id), 0)::text as cost
    from runs r
    where r.status = 'finished' and r.stages = ${stages}::text[]
      and r.params -> 'scopeSize' ->> 'unit' = ${size.unit}
      and coalesce((r.params -> 'scopeSize' ->> 'count')::numeric, 0) > 0
    order by coalesce(r.finished_at, r.created_at) desc, r.id desc
    limit 1`);
  const row = rows[0];
  if (!row) return { eur: null, basis: null, text: "keine Grundlage (noch kein vergleichbarer Lauf)" };
  const basisCount = Number(row.count);
  const costEur = Number(row.cost);
  const eur = round2((costEur / basisCount) * size.count);
  return {
    eur,
    basis: { runId: row.id, costEur, size: { unit: size.unit, count: basisCount } },
    text: `ca. ${eur.toFixed(2)} EUR (nach dem letzten vergleichbaren Lauf: ${costEur.toFixed(2)} EUR für ${basisCount})`,
  };
}

/** Stores the size of the run next to its params, so a later estimate can scale from it. */
export async function recordScopeSize(db: Db, runId: string, size: ScopeSize): Promise<void> {
  await db.execute(sql`update runs set params = params || ${JSON.stringify({ scopeSize: size })}::jsonb where id = ${runId}`);
}
