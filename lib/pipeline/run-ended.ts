import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";

/*
 * Follow-ups of a run's end (spec 14: the queue of subdivision builds). The modules that end runs (the worker,
 * `enqueueStage`) call `runEnded`; what happens then is registered by the composition root (`lib/jobs/registry.ts`),
 * so this module imports no starter and closes no import cycle (ruling M6-P17). Without a registered hook nothing
 * happens (the web process: „Lauf beenden“ calls its follow-up itself).
 */

export type RunEndedHook = (db: Db, boss: PgBoss, runId: string) => Promise<void>;

const hooks = new Set<RunEndedHook>();

/** Registers a follow-up; registering the same function twice keeps one. */
export function onRunEnded(hook: RunEndedHook): void {
  hooks.add(hook);
}

/** Runs every registered follow-up for the ended run `runId`, in the caller's transaction. */
export async function runEnded(db: Db, boss: PgBoss, runId: string): Promise<void> {
  for (const hook of hooks) await hook(db, boss, runId);
}
