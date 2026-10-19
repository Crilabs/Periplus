import { and, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { pickConverterSample, samplesToCompare } from "@/lib/domain/converter-comparison";
import { createRun } from "@/lib/domain/runs";
import { COMPARE_STAGE } from "./compare-converters";
import { enqueueStage } from "./runs";
import { RunScopeNotReady } from "./tile-scope";

// Kept apart from ./compare-converters: the job handler imports that module, and this one reaches the stage registry
// through ./runs (ruling M3-P1).

/** Scope id of a converter comparison run (scope type `system`). */
export const COMPARISON_SCOPE = "converters";

/**
 * Starts the run "Konverter-Vergleich": tops up the sample (`pickConverterSample`, the existing sample stays), then
 * one `compare.converters` job per sample without a successful output of every converter. Refused before the run
 * exists (`RunScopeNotReady`) while another comparison run is queued or running (checked with the run insert in one
 * transaction under an advisory lock), without any sample
 * (`no_converter_samples`) and when every sample is complete (`converter_samples_done`).
 */
export async function startConverterComparison(db: Db, boss: PgBoss, triggeredBy: string): Promise<{ id: string; samples: number }> {
  const created = await db.transaction(async (tx) => {
    // Like the fetch starts (ruling M3-F-R2): of two concurrent starts the second waits here and then sees the run.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${COMPARISON_LOCK}))`);
    const [active] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(inArray(runs.status, ["queued", "running"]), sql`${COMPARE_STAGE} = any(${runs.stages})`))
      .limit(1);
    if (active) throw new RunScopeNotReady("comparison_run_active", `Comparison run ${active.id} is still active`);
    await pickConverterSample(tx);
    const sampleIds = await samplesToCompare(tx);
    if (sampleIds.length === 0) {
      const [{ n }] = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from converter_samples`)).rows as [{ n: number }];
      if (n === 0) throw new RunScopeNotReady("no_converter_samples", "No approved source has HTML documents to sample");
      throw new RunScopeNotReady("converter_samples_done", "Every sample has an output of every converter");
    }
    const { id } = await createRun(tx, {
      kind: "stage",
      scope: { type: "system", id: COMPARISON_SCOPE },
      params: { sampleIds },
      stages: [COMPARE_STAGE],
      triggeredBy,
    });
    return { id, samples: sampleIds.length };
  });
  await enqueueStage(db, boss, created.id, COMPARE_STAGE);
  return created;
}

/** Advisory lock key of the comparison start. */
export const COMPARISON_LOCK = "compare-converters-run";
