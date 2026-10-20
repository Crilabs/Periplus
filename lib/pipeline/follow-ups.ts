import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { createLogger } from "@/lib/logger";
import { startConsolidationRun } from "./consolidation/run";
import { startGeometryRun } from "./geometry-run";
import { startTextRun } from "./text/run";
import { RunScopeNotReady, type RunScopeReason } from "./tile-scope";

/*
 * The runs an admin decision asks for once it has committed (rulings M5-P10, M5-F-R4: never inside the decision's
 * transaction, which could roll back under a started run). One place for every decision kind (gesamt review UI-16):
 * the decision stands whatever happens here, so nothing throws. A scope lacking an input (`RunScopeNotReady`) is
 * logged as a warning, any other failure (e.g. the job queue is down) as an error (ruling M5-H-R2 M-6, UI-7), and the
 * outcome tells the page which notice to show.
 */

/** `started` with the run; `not_ready` when its scope lacks an input; `failed` when it did not start for another reason. */
export type FollowUp = { status: "started"; runId: string } | { status: "not_ready"; reason: RunScopeReason } | { status: "failed" };

/** The job queue, asked for only when a run starts (a queue that is down is a `failed` follow-up, not an error page). */
export type BossGetter = () => Promise<PgBoss>;

async function followUp(what: string, context: Record<string, unknown>, start: () => Promise<{ id: string }>): Promise<FollowUp> {
  const log = createLogger("follow-up");
  try {
    return { status: "started", runId: (await start()).id };
  } catch (e) {
    if (e instanceof RunScopeNotReady) {
      log.warn({ ...context, reason: e.reason }, `${what} run not started`);
      return { status: "not_ready", reason: e.reason };
    }
    log.error({ ...context, err: e }, `${what} run failed to start after the decision`);
    return { status: "failed" };
  }
}

/** The first of several follow-ups that did not start, else the last one started (or null when there were none). */
export function combined(outcomes: FollowUp[]): FollowUp | null {
  return outcomes.find((o) => o.status === "failed") ?? outcomes.find((o) => o.status === "not_ready") ?? outcomes.at(-1) ?? null;
}

/** A consolidation run of one object (its profile again; with `stagesOnly` e.g. only the summary). */
export function consolidateAfter(
  db: Db,
  boss: BossGetter,
  input: { geoObjectId: string; stagesOnly?: string[]; triggeredBy: string },
): Promise<FollowUp> {
  return followUp("consolidation", { geoObjectId: input.geoObjectId }, async () =>
    startConsolidationRun(db, await boss(), {
      scope: { geoObjectIds: [input.geoObjectId] },
      triggeredBy: input.triggeredBy,
      ...(input.stagesOnly ? { stagesOnly: input.stagesOnly } : {}),
    }),
  );
}

/**
 * The rematch after a "Neuer Name" decision (`create_place`, `assign_name`): a text run over the current versions that
 * named it. A version that is no longer current by now is taken in by the next text run of its tile.
 */
export function rematchAfter(db: Db, boss: BossGetter, input: { documentVersionIds: string[]; triggeredBy: string }): Promise<FollowUp> {
  return followUp("rematch", { documentVersionIds: input.documentVersionIds }, async () =>
    startTextRun(db, await boss(), { documentVersionIds: input.documentVersionIds, rematch: true, triggeredBy: input.triggeredBy }),
  );
}

/** A geometry run for one place, after its anchor position was set. */
export function geometryAfter(db: Db, boss: BossGetter, input: { placeId: string; triggeredBy: string }): Promise<FollowUp> {
  return followUp("geometry", { placeId: input.placeId }, async () => startGeometryRun(db, await boss(), { placeId: input.placeId }, input.triggeredBy));
}

/**
 * After „Position korrigieren“ (ruling M6-H-R1): a geometry run for the place recomputes shelter and depths and
 * consolidates; when it does not start (no geometry inputs, or the queue), a consolidation run takes the new position
 * into the profile instead.
 */
export async function afterPositionChange(
  db: Db,
  boss: BossGetter,
  input: { placeId: string; geoObjectId: string; triggeredBy: string },
): Promise<FollowUp> {
  const geometry = await geometryAfter(db, boss, input);
  if (geometry.status === "started") return geometry;
  return consolidateAfter(db, boss, { geoObjectId: input.geoObjectId, triggeredBy: input.triggeredBy });
}

/**
 * After „Mit Ort zusammenlegen“ (ruling M6-P15): consolidates the merged object in place, which only waits for a
 * consolidation of it still running and dismisses the open tasks that one opened after the merge locked its tasks
 * (`object_ended`; a run's scope refuses a merged object), then a consolidation run for the surviving object.
 */
export async function afterPlaceMerge(
  db: Db,
  boss: BossGetter,
  input: { keepGeoObjectId: string; dropGeoObjectId: string; triggeredBy: string },
): Promise<FollowUp> {
  try {
    await consolidateGeo(db, input.dropGeoObjectId);
  } catch (e) {
    createLogger("follow-up").error({ geoObjectId: input.dropGeoObjectId, err: e }, "merged object not settled after a place merge");
  }
  return consolidateAfter(db, boss, { geoObjectId: input.keepGeoObjectId, triggeredBy: input.triggeredBy });
}
