import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { areaByKey, getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, placeDiscoveryRequests, tiles } from "@/lib/db/schema";
import { createRun } from "@/lib/domain/runs";
import { tileExists } from "@/lib/domain/geo-view";
import { DISCOVERY_AREA_STAGE, DISCOVERY_PLACE_STAGE, DISCOVERY_PROPOSE_STAGE, DISCOVERY_TILE_STAGE } from "./discovery";
import { enqueueStage, startRun } from "./runs";
import { areaGeoObjectId, RunScopeNotReady, seedTileIds } from "./tile-scope";

// Kept apart from ./discovery: the job handlers import that module, and this one reaches the stage registry
// through ./runs, which would close an import cycle through the handlers.

/** Scope id of a proposal run (scope type `system`). */
export const PROPOSAL_RUN_SCOPE = "discovery";

/** Scope id of a targeted discovery for places (scope type `system`). */
export const PLACE_DISCOVERY_RUN_SCOPE = "places";

/** The stages of a targeted discovery for places. */
export const PLACE_DISCOVERY_STAGES = [DISCOVERY_PLACE_STAGE, DISCOVERY_PROPOSE_STAGE] as const;

/**
 * Starts the run "Quellenfindung" for an area (stages `discovery.area`, `discovery.tile`, `discovery.propose`)
 * or one tile (`discovery.tile`, `discovery.propose`). Checked before the run exists: the area is configured and
 * has its geo object and coast tiles (`RunScopeNotReady`), or the tile exists and belongs to a configured area,
 * whose source languages its queries need (`RunScopeNotReady` `tile_without_area`).
 */
export async function startDiscoveryRun(
  db: Db,
  boss: PgBoss,
  scope: { areaKey: string } | { tileId: string },
  triggeredBy: string,
): Promise<{ id: string }> {
  if ("areaKey" in scope) {
    areaByKey(scope.areaKey);
    if (!(await areaGeoObjectId(db, scope.areaKey))) {
      throw new RunScopeNotReady(
        "area_without_geo_object",
        `Area ${scope.areaKey} has no geo object yet; build its gazetteer first`,
      );
    }
    if ((await seedTileIds(db, { areaKey: scope.areaKey })).length === 0) {
      throw new RunScopeNotReady(
        "area_without_coast_tiles",
        `Area ${scope.areaKey} has no coast tiles yet; build its gazetteer first`,
      );
    }
    return startRun(db, boss, {
      kind: "stage",
      scope: { type: "area", id: scope.areaKey },
      params: { areaKey: scope.areaKey },
      stages: [DISCOVERY_AREA_STAGE, DISCOVERY_TILE_STAGE, DISCOVERY_PROPOSE_STAGE],
      triggeredBy,
    });
  }
  if (!(await tileExists(db, scope.tileId))) throw new Error(`Unknown tile ${scope.tileId}`);
  const [tile] = await db
    .select({ areaKey: geoObjects.configKey })
    .from(tiles)
    .leftJoin(geoObjects, eq(geoObjects.id, tiles.areaId))
    .where(eq(tiles.id, scope.tileId));
  if (!tile?.areaKey || !getConfig().areas.some((a) => a.key === tile.areaKey)) {
    throw new RunScopeNotReady(
      "tile_without_area",
      `Tile ${scope.tileId} has no configured area; its queries need the area's source languages`,
    );
  }
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "tile", id: scope.tileId },
    params: { tileIds: [scope.tileId] },
    stages: [DISCOVERY_TILE_STAGE, DISCOVERY_PROPOSE_STAGE],
    triggeredBy,
  });
}

/** Starts a run with only `discovery.propose` (e.g. after a crawl filled the link graph). */
export async function startProposalRun(db: Db, boss: PgBoss, triggeredBy: string): Promise<{ id: string }> {
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "system", id: PROPOSAL_RUN_SCOPE },
    stages: [DISCOVERY_PROPOSE_STAGE],
    triggeredBy,
  });
}

/**
 * Starts a targeted source discovery for places (spec 07 Folgeaufträge): kind `event`, scope `system` / `places`,
 * stages `discovery.place` (the tile templates with each place's names) and `discovery.propose`, params
 * `{ geoObjectIds }`. Every id must be a valid, unmerged geo object with a valid, unmerged place
 * (`RunScopeNotReady` `geo_object_without_place`, checked before the run exists). The run row and one
 * `place_discovery_requests` row per object (the cool-down of `thinPlaces`) are written in one transaction, then the
 * first stage is enqueued.
 */
export async function startPlaceDiscoveryRun(
  db: Db,
  boss: PgBoss,
  input: { geoObjectIds: string[]; triggeredBy: string },
): Promise<{ id: string }> {
  const ids = [...new Set(input.geoObjectIds)].sort();
  if (ids.length === 0) throw new RunScopeNotReady("geo_object_without_place", "no geo object given");
  const { rows } = await db.execute<{ id: string }>(sql`
    select o.id from geo_objects o
    where o.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
      and o.merged_into_id is null and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)
      and exists (
        select 1 from places p where p.geo_object_id = o.id and p.merged_into_id is null
          and p.valid_from <= current_date and (p.valid_to is null or p.valid_to > current_date)
      )
  `);
  const valid = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !valid.has(id));
  if (missing.length > 0) {
    throw new RunScopeNotReady("geo_object_without_place", `geo objects without a valid place: ${missing.join(", ")}`);
  }
  const created = await db.transaction(async (tx) => {
    const run = await createRun(tx, {
      kind: "event",
      scope: { type: "system", id: PLACE_DISCOVERY_RUN_SCOPE },
      stages: [...PLACE_DISCOVERY_STAGES],
      params: { geoObjectIds: ids },
      triggeredBy: input.triggeredBy,
    });
    await tx.insert(placeDiscoveryRequests).values(ids.map((geoObjectId) => ({ geoObjectId, runId: run.id })));
    return run;
  });
  await enqueueStage(db, boss, created.id, PLACE_DISCOVERY_STAGES[0]);
  return created;
}
