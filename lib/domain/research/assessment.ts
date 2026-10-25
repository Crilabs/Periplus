import { resolveTaskModel } from "@/lib/ai/cost";
import type { AssessPageOutput } from "@/lib/ai/tasks/assess-page";
import { assessPageTask } from "@/lib/ai/tasks/assess-page";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { pageAssessments } from "@/lib/db/schema";
import type { ObservedAtBasis } from "@/lib/db/schema/sources";
import { plausibleDate } from "@/lib/domain/research/util/dates";

/*
 * Page assessment of a research hit (spec 18): one row per page version, model and prompt version. "Ohne explizites
 * Beobachtungsdatum gilt `published_at`, sonst Abrufdatum"; a month becomes day 15, a date after the fetch date or
 * one that is not `YYYY-MM(-DD)` is ignored.
 */

const MAX_REASON_CHARS = 300;
const MAX_BERTHS = 50;

/** The model and prompt version the configuration assesses with now. */
export function activeAssessor(config: AppConfig = getConfig()): { model: string; promptVersion: number } {
  const { model, taskConfig } = resolveTaskModel(config, assessPageTask.name);
  return { model, promptVersion: taskConfig.promptVersion };
}

function observation(
  out: Pick<AssessPageOutput, "observed_at" | "observed_at_explicit">,
  meta: { fetchedAt: Date; publishedAt: string | null },
  earliest: string,
): { observedAt: string; basis: ObservedAtBasis } {
  const explicit = out.observed_at_explicit ? plausibleDate(out.observed_at, meta.fetchedAt, earliest, true) : null;
  if (explicit) return { observedAt: explicit, basis: "explicit" };
  if (meta.publishedAt) return { observedAt: meta.publishedAt, basis: "published" };
  return { observedAt: meta.fetchedAt.toISOString().slice(0, 10), basis: "fetched" };
}

/** Stores the assessment of a version; one already stored for the model and prompt version stays as it is. */
export async function storeAssessment(
  db: Db,
  versionId: string,
  out: AssessPageOutput,
  meta: { model: string; promptVersion: number; runId: string; fetchedAt: Date; publishedAt: string | null },
): Promise<void> {
  const { observedAt, basis } = observation(out, meta, getConfig().extraction.earliestDate);
  // The reason justifies an explicit date only; for any other basis it would contradict the stored date.
  const reason = basis === "explicit" ? out.observed_at_reason?.trim().slice(0, MAX_REASON_CHARS) || null : null;
  await db
    .insert(pageAssessments)
    .values({
      documentVersionId: versionId,
      model: meta.model,
      promptVersion: meta.promptVersion,
      pageKind: out.page_kind,
      firstHand: out.first_hand,
      generated: out.generated,
      language: out.language?.trim().toLowerCase() || null,
      observedAt,
      observedAtBasis: basis,
      observedAtReason: reason,
      berths: out.berths.slice(0, MAX_BERTHS),
      runId: meta.runId,
    })
    .onConflictDoNothing();
}
