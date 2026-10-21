import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { summarizeProfileTask, type SummarizeInput } from "@/lib/ai/tasks/summarize-profile";
import { ModelOutputInvalid, type ModelClient } from "@/lib/ai/types";
import { getConfig } from "@/lib/config";
import { consolidationConfigFor } from "@/lib/domain/consolidation/active-rules";
import type { Db } from "@/lib/db/client";
import { profiles, profileSummaries, reviewTasks } from "@/lib/db/schema";
import { checkSummary, summaryInput } from "@/lib/domain/consolidation/summary";
import { consolidationTargets } from "@/lib/domain/consolidation/targets";
import type { ProfileSnapshot } from "@/lib/domain/consolidation/types";
import { levelFor } from "@/lib/domain/facts/levels";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { selectedAnywhere } from "@/lib/domain/highlights/selections";
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
 * version of each target of the run (`consolidationTargets`: its `geoObjectIds`, tile, subdivision or comparison set).
 * Either way they include the POIs the highlights stage consolidated (their profiles carry the run). Kept: objects
 * whose fact level is in `summary.levels`, a POI only when some place selected it as a highlight (`selectedAnywhere`;
 * rules without `highlights` keep every POI, spec 16), and versions without an
 * `ok` summary of the current prompt version; with `params.regenerateSummary` („Summary neu erzeugen“, ruling M6-H-R1)
 * also versions with one.
 */
export async function summaryTargets(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<Target[]> {
  const cfg = await consolidationConfigFor(db, run.params.rulesVersion);
  let candidates: Target[];
  if (Array.isArray(run.params.stagesOnly)) {
    const ids = await consolidationTargets(db, run);
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
  const regenerate = run.params.regenerateSummary === true;
  // spec 16: with highlights rules only a POI some place selected (a highlight) gets a summary
  const highlights = cfg.highlights ? new Set(await selectedAnywhere(db, candidates.map((c) => c.geoObjectId))) : null;
  const targets: Target[] = [];
  for (const c of candidates) {
    const level = await levelFor(db, c.geoObjectId);
    if (level === null || !(cfg.summary.levels as readonly string[]).includes(level)) continue;
    if (level === "poi" && highlights && !highlights.has(c.geoObjectId)) continue;
    if (regenerate) {
      targets.push(c);
      continue;
    }
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

/**
 * One job per target (`key` `<geoObjectId>:<version>`), with `regenerate` for „Summary neu erzeugen“ and the run's
 * frozen `rulesVersion` (ruling M7-E-R1: the summary keeps the run's rules across an activation).
 */
export async function summaryJobs(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]> {
  const regenerate = run.params.regenerateSummary === true ? { regenerate: true } : {};
  const rulesVersion = typeof run.params.rulesVersion === "string" ? { rulesVersion: run.params.rulesVersion } : {};
  return (await summaryTargets(db, run)).map((t) => ({ key: `${t.geoObjectId}:${t.version}`, geoObjectId: t.geoObjectId, version: t.version, ...regenerate, ...rulesVersion }));
}

export type SummaryResult = { status: "ok" | "empty" | "skipped"; attempts: number };

/**
 * Summarizes one profile version: up to `summary.maxAttempts` model calls, from the second on with `avoid` ("formuliere
 * ganz eigenständig"). An answer that copies 15 words from the archive, misses the sentence range, or is cut off,
 * refused or invalid (`ModelOutputInvalid`, ruling M5-P14) is a failed attempt. The first good answer is stored as
 * `ok` (attempts, model, prompt version) and closes the object's open `failed_job` task on a `profile_summary`. After the last failed attempt an `empty` summary is stored and one
 * `failed_job` task opened on subject `profile_summary` `<geoObjectId>:<version>`, in one transaction. Skipped: an
 * unknown version, a level without summaries, an existing `ok` summary of the prompt version, or an `empty` one this
 * run already stored (a retried job). With `regenerate` („Summary neu erzeugen“, ruling M6-H-R1, needs `runId`) an
 * existing `ok` summary is no reason to skip, only one this run already stored: the new one is stored beside it and
 * the newest `ok` summary is the one shown and delivered; when every attempt fails, the old one stays. Other errors
 * (budget, provider) propagate, so the job is retried. The settings come from `rulesVersion` (the run's frozen version,
 * carried by the job), else from the active rules.
 */
export async function summarizeProfile(
  db: Db,
  input: { geoObjectId: string; version: number; runId?: string; regenerate?: boolean; rulesVersion?: string },
  deps: { model: ModelClient },
): Promise<SummaryResult> {
  const cfg = await consolidationConfigFor(db, input.rulesVersion);
  const prompt = promptVersion();
  const [row] = await db
    .select({ attributes: profiles.attributes, provenance: profiles.provenance, confidence: profiles.confidence })
    .from(profiles)
    .where(and(eq(profiles.geoObjectId, input.geoObjectId), eq(profiles.version, input.version)));
  if (!row) return { status: "skipped", attempts: 0 };
  const level = await levelFor(db, input.geoObjectId);
  if (level !== "place" && level !== "poi") return { status: "skipped", attempts: 0 };
  if (!cfg.summary.levels.includes(level)) return { status: "skipped", attempts: 0 };
  if (input.regenerate && !input.runId) throw new Error("regenerating a summary needs the run id");
  const regenerate = input.regenerate === true;
  const { rows: existing } = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from profile_summaries
    where geo_object_id = ${input.geoObjectId} and profile_version = ${input.version}
      and ((status = 'ok' and prompt_version = ${prompt} and (not ${regenerate} or run_id = ${input.runId ?? null}::uuid))
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
      // an ok summary closes the open "summary stayed empty" task of the object (a regeneration, or a later version)
      await db.transaction(async (tx) => {
        await tx
          .insert(profileSummaries)
          .values({ geoObjectId: input.geoObjectId, profileVersion: input.version, text, status: "ok", attempts: attempt, model, promptVersion: prompt, runId: input.runId ?? null })
          .onConflictDoNothing();
        await tx
          .update(reviewTasks)
          .set({ status: "dismissed", context: sql`${reviewTasks.context} || '{"dismissedReason":"summary_stored"}'::jsonb` })
          .where(
            and(
              eq(reviewTasks.kind, "failed_job"),
              eq(reviewTasks.subjectType, "profile_summary"),
              eq(reviewTasks.status, "open"),
              sql`${reviewTasks.subjectId} like ${`${input.geoObjectId}:%`}`,
            ),
          );
      });
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
