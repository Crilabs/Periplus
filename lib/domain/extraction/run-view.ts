import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { extractionRuns, type ExtractionPurpose, type ExtractionRunBlockReason, type ExtractionRunStatus } from "@/lib/db/schema";

/*
 * The extraction runs of a run for the run page (ruling M4-P16): per extraction run its model, prompt, purpose, facts
 * (or route stops), rejected quotes, Belegtreue from the recorded quote check and status with block reason.
 */

export type ExtractionRunRow = {
  id: string;
  task: string;
  model: string;
  promptVersion: number;
  factSchemaVersion: string;
  purpose: ExtractionPurpose;
  status: ExtractionRunStatus;
  blockedReason: ExtractionRunBlockReason | null;
  /** Stored facts (`extract-facts`) or route stops (`extract-route`), from the run's counters; null before the check. */
  items: number | null;
  /** Facts whose quote the check on receipt did not find in the text (not stored); null for routes or before the check. */
  rejectedQuotes: number | null;
  costEur: number | null;
  /** The recorded quote check: checked items, verified, share and the first failure reasons; null before the check. */
  quoteCheck: { facts: number; verified: number; ratio: number; failures: Array<{ kind: string; reason: string }> } | null;
  startedAt: Date;
  finishedAt: Date | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The extraction runs of the run, in start order. */
export async function extractionRunsOfRun(db: Db, runId: string): Promise<ExtractionRunRow[]> {
  const rows = await db
    .select()
    .from(extractionRuns)
    .where(eq(extractionRuns.runId, runId))
    .orderBy(asc(extractionRuns.startedAt), asc(extractionRuns.id));
  return rows.map((r) => {
    const stats = (r.stats ?? {}) as Record<string, unknown>;
    const check = r.quoteCheck as { facts?: unknown; verified?: unknown; ratio?: unknown; failures?: unknown } | null;
    const failures = Array.isArray(check?.failures) ? (check.failures as Array<{ kind?: unknown; reason?: unknown }>) : [];
    return {
      id: r.id,
      task: r.task,
      model: r.model,
      promptVersion: r.promptVersion,
      factSchemaVersion: r.factSchemaVersion,
      purpose: r.purpose,
      status: r.status,
      blockedReason: r.blockedReason,
      items: r.task === "extract-route" ? num(stats.stops) : num(stats.facts),
      rejectedQuotes: r.task === "extract-route" ? null : num(stats.rejectedQuote),
      costEur: num(stats.costEur),
      quoteCheck: check
        ? {
            facts: num(check.facts) ?? 0,
            verified: num(check.verified) ?? 0,
            ratio: num(check.ratio) ?? 0,
            failures: failures.map((f) => ({ kind: String(f.kind ?? ""), reason: String(f.reason ?? "") })),
          }
        : null,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    };
  });
}
