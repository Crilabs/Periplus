import { asc, eq } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { extractionRuns } from "@/lib/db/schema";
import { checkQuoteFidelity, type QuoteFidelity } from "@/lib/domain/extraction/fidelity";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import { EXTRACT_FACTS_TASK, extractionRunStats } from "./extract";
import { EXTRACT_ROUTE_TASK, routeRunStats } from "./routes";

/*
 * Stage `extraction.check` (spec 06, Belegtreue), the last stage of a text run: one job per extraction run of the run
 * (regular, reprocess and comparison runs alike). It ends the extraction run's lifecycle (ruling M4-G-R3 f): writes its
 * counters to `extraction_runs.stats`, checks every quote again (`checkQuoteFidelity`) and finishes it, or blocks it
 * when the Belegtreue is below 100 %. Earlier stages have all finished by then, so every unit has its outcome.
 */

export const CHECK_STAGE = "extraction.check";
export const CHECK_QUEUE = "extraction.check" as const;

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.text.check"));

/** Plan: one job per extraction run of the run, in id order (a repeated plan plans the same jobs). */
export async function planCheck(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]> {
  const rows = await db
    .select({ id: extractionRuns.id })
    .from(extractionRuns)
    .where(eq(extractionRuns.runId, run.id))
    .orderBy(asc(extractionRuns.id));
  return rows.map((r) => ({ key: `check:${r.id}`, extractionRunId: r.id }));
}

/**
 * Writes the extraction run's counters and records its quote check (status `finished` or `blocked`), in one
 * transaction. Idempotent: a retried job writes the same result.
 */
export async function checkExtractionRun(db: Db, extractionRunId: string, config: AppConfig = getConfig()): Promise<QuoteFidelity> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select({ task: extractionRuns.task }).from(extractionRuns).where(eq(extractionRuns.id, extractionRunId)).for("update");
    if (!run) throw new Error(`extraction run ${extractionRunId} does not exist`);
    if (run.task === EXTRACT_FACTS_TASK) await extractionRunStats(tx, extractionRunId);
    else if (run.task === EXTRACT_ROUTE_TASK) await routeRunStats(tx, extractionRunId);
    const fidelity = await checkQuoteFidelity(tx, extractionRunId, config);
    const log = getLog();
    const entry = { extractionRunId, task: run.task, facts: fidelity.facts, verified: fidelity.verified, ratio: fidelity.ratio };
    if (fidelity.ratio < 1) log.warn({ ...entry, first: fidelity.failures[0] }, "extraction run blocked: Belegtreue below 100 %");
    else log.info(entry, "extraction run finished");
    return fidelity;
  });
}
