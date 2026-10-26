import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { createLogger } from "@/lib/logger";
import { startGeometryRun } from "./geometry-run";
import { startImageRun } from "./images-run";
import type { ImageView } from "./images/generate";
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

/** A geometry run for one place, after its anchor position was set. */
export function geometryAfter(db: Db, boss: BossGetter, input: { placeId: string; triggeredBy: string }): Promise<FollowUp> {
  return followUp("geometry", { placeId: input.placeId }, async () => startGeometryRun(db, await boss(), { placeId: input.placeId }, input.triggeredBy));
}

/**
 * After „Neu erzeugen“ on a place image (spec 13): an image run of the place's slot at the chosen zoom, with `force` so
 * the decided task carrying the same key does not skip it.
 */
export function imageRunAfter(
  db: Db,
  boss: BossGetter,
  input: { geoObjectId: string; view: ImageView; force: boolean; triggeredBy: string },
): Promise<FollowUp> {
  return followUp("image", { geoObjectId: input.geoObjectId, slot: input.view.slot }, async () =>
    startImageRun(db, await boss(), { geoObjectId: input.geoObjectId, view: input.view, force: input.force }, input.triggeredBy),
  );
}
