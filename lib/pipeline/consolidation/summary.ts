import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { summarizeProfileTask, type SummarizeInput } from "@/lib/ai/tasks/summarize-profile";
import { ModelOutputInvalid, type ModelClient } from "@/lib/ai/types";
import { getConfig, getConsolidationConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { profiles, profileSummaries } from "@/lib/db/schema";
import { checkSummary, summaryInput } from "@/lib/domain/consolidation/summary";
import type { ProfileSnapshot } from "@/lib/domain/consolidation/types";
import { levelFor } from "@/lib/domain/facts/levels";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { createReviewTask } from "@/lib/domain/review";
import type { JobData } from "@/lib/jobs/worker";
import { CONSOLIDATION_SUMMARY_STAGE } from "./stages";

/*
 * Stage `consolidation.summary` (spec 07 `summary.de`, plan Task 14): a German summary per new profile version, written
 * by the model only from the profile's values and checked against the archive (15 words) and the sentence count.
 * Every model call runs outside any transaction (ruling M5-P14).
 */

const TASK = summarizeProfileTask.name;

const promptVersion = () => {
  const task = getConfig().models.tasks[TASK];
  if (!task) throw new Error(`config/models.json has no task ${TASK}`);
  return task.promptVersion;
};

type Target = { geoObjectId: string; version: number };

/**
 * The profile versions to summarize for a run: the versions this run created (newest per object), or with
 * `params.stagesOnly` (a summary run started for given objects, e.g. "Neu erzeugen" after a failed summary) the newest
 * version of each `params.geoObjectIds`. Kept: objects whose fact level is in `summary.levels` and versions without an
 * `ok` summary of the current prompt version.
 */
export async function summaryTargets(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<Target[]> {
  const cfg = getConsolidationConfig();
  let candidates: Target[];
  if (Array.isArray(run.params.stagesOnly)) {
    const ids = Array.isArray(run.params.geoObjectIds) ? run.params.geoObjectIds.filter((v): v is string => typeof v === "string") : [];
    if (ids.length === 0) return [];
    candidates = await db
      .selectDistinctOn([profiles.geoObjectId], { geoObjectId: profiles.geoObjectId, version: profiles.version })
      .from(profiles)
      .where(inArray(profiles.geoObjectId, ids))
      .orderBy(profiles.geoObjectId, desc(profiles.version));
  } else {
    candidates = await db
      .selectDistinctOn([profiles.geoObjectId], { geoObjectId: profiles.geoObjectId, version: profiles.version })
      .from(profiles)
      .where(eq(profiles.runId, run.id))
      .orderBy(profiles.geoObjectId, desc(profiles.version));
  }
  const prompt = promptVersion();
  const targets: Target[] = [];
  for (const c of candidates) {
    const level = await levelFor(db, c.geoObjectId);
    if (level === null || !(cfg.summary.levels as readonly string[]).includes(level)) continue;
    const [done] = await db
      .select({ id: profileSummaries.id })
      .from(profileSummaries)
      .where(
        and(
          eq(profileSummaries.geoObjectId, c.geoObjectId),
          eq(profileSummaries.profileVersion, c.version),
          eq(profileSummaries.promptVersion, prompt),
          eq(profileSummaries.status, "ok"),
        ),
      )
      .limit(1);
    if (!done) targets.push(c);
  }
  return targets;
}

/** One job per target (`key` `<geoObjectId>:<version>`). */
export async function summaryJobs(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]> {
  return (await summaryTargets(db, run)).map((t) => ({ key: `${t.geoObjectId}:${t.version}`, geoObjectId: t.geoObjectId, version: t.version }));
}

export type SummaryResult = { status: "ok" | "empty" | "skipped"; attempts: number };

/**
 * Summarizes one profile version: up to `summary.maxAttempts` model calls, from the second on with `avoid` ("formuliere
 * ganz eigenständig"). An answer that copies 15 words from the archive, misses the sentence range, or is cut off,
 * refused or invalid (`ModelOutputInvalid`, ruling M5-P14) is a failed attempt. The first good answer is stored as
 * `ok` (attempts, model, prompt version). After the last failed attempt an `empty` summary is stored and one
 * `failed_job` task opened on subject `profile_summary` `<geoObjectId>:<version>`, in one transaction. Skipped: an
 * unknown version, a level without summaries, an existing `ok` summary of the prompt version, or an `empty` one this
 * run already stored (a retried job). Other errors (budget, provider) propagate, so the job is retried.
 */
export async function summarizeProfile(
  db: Db,
  input: { geoObjectId: string; version: number; runId?: string },
  deps: { model: ModelClient },
): Promise<SummaryResult> {
  const cfg = getConsolidationConfig();
  const prompt = promptVersion();
  const [row] = await db
    .select({ attributes: profiles.attributes, provenance: profiles.provenance, confidence: profiles.confidence })
    .from(profiles)
    .where(and(eq(profiles.geoObjectId, input.geoObjectId), eq(profiles.version, input.version)));
  if (!row) return { status: "skipped", attempts: 0 };
  const level = await levelFor(db, input.geoObjectId);
  if (level !== "place" && level !== "poi") return { status: "skipped", attempts: 0 };
  if (!cfg.summary.levels.includes(level)) return { status: "skipped", attempts: 0 };
  const { rows: existing } = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from profile_summaries
    where geo_object_id = ${input.geoObjectId} and profile_version = ${input.version}
      and ((status = 'ok' and prompt_version = ${prompt})
           or (status = 'empty' and ${input.runId ?? null}::uuid is not null and run_id = ${input.runId ?? null}::uuid))
  `);
  if (Number(existing[0]?.n ?? 0) > 0) return { status: "skipped", attempts: 0 };

  const { rows: names } = await db.execute<{ name: string | null }>(sql`select ${displayNameSql(sql`${input.geoObjectId}::uuid`)} as name`);
  const base = summaryInput(row as Pick<ProfileSnapshot, "attributes" | "provenance" | "confidence">, {
    level,
    name: names[0]?.name ?? "(ohne Namen)",
    cfg,
  });
  const reasons: string[] = [];
  let model: string | null = null;
  for (let attempt = 1; attempt <= cfg.summary.maxAttempts; attempt++) {
    const request: SummarizeInput = { ...base, avoid: attempt > 1 };
    let text: string;
    try {
      const result = await deps.model.call(summarizeProfileTask, request, { runId: input.runId, stage: CONSOLIDATION_SUMMARY_STAGE });
      model = result.model;
      text = result.output.text.trim();
    } catch (e) {
      if (!(e instanceof ModelOutputInvalid)) throw e;
      reasons.push("invalid");
      continue;
    }
    const verdict = await checkSummary(db, text, base.sentences);
    if (verdict === "ok") {
      await db
        .insert(profileSummaries)
        .values({ geoObjectId: input.geoObjectId, profileVersion: input.version, text, status: "ok", attempts: attempt, model, promptVersion: prompt, runId: input.runId ?? null })
        .onConflictDoNothing();
      return { status: "ok", attempts: attempt };
    }
    reasons.push(verdict);
  }

  const attempts = cfg.summary.maxAttempts;
  await db.transaction(async (tx) => {
    await tx.insert(profileSummaries).values({
      geoObjectId: input.geoObjectId,
      profileVersion: input.version,
      text: null,
      status: "empty",
      attempts,
      model,
      promptVersion: prompt,
      runId: input.runId ?? null,
    });
    await createReviewTask(tx, {
      kind: "failed_job",
      subjectType: "profile_summary",
      subjectId: `${input.geoObjectId}:${input.version}`,
      context: { geoObjectId: input.geoObjectId, version: input.version, stage: CONSOLIDATION_SUMMARY_STAGE, runId: input.runId ?? null, attempts, reasons },
    });
  });
  return { status: "empty", attempts };
}
