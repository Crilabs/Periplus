import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import type { QualityConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import {
  COMPARISON_ATTRIBUTES,
  comparisonResults,
  reviewTasks,
  type ComparisonAttribute,
  type ComparisonMethod,
  type ComparisonResultValue,
} from "@/lib/db/schema";
import { createReviewTask } from "@/lib/domain/review";
import { comparisonValues, type ComparisonSubject } from "./comparison-values";

/*
 * Outcomes of the comparison against Navily (spec 10), append-only. Grundprinzip 9: an outcome, the hash of the own
 * value and its own display are all that is written; a Navily value never reaches a row or a review context.
 */

/** Outcomes a person decided on a `comparison_deviation` task; a later machine or manual outcome never replaces one. */
const REVIEW_OUTCOMES: ReadonlySet<ComparisonResultValue> = new Set(["deviation_confirmed_own", "deviation_confirmed_navily", "unclear"]);

const VALUE_HASH = /^[0-9a-f]{16}$/;

const entrySchema = z.object({
  attribute: z.enum(COMPARISON_ATTRIBUTES),
  result: z.enum(["match", "deviation", "not_at_navily"]),
  valueHash: z.string().regex(VALUE_HASH),
  profileVersion: z.number().int().positive().nullable(),
});

export type ComparisonEntry = z.infer<typeof entrySchema>;

const key = (placeId: string, attribute: string, valueHash: string) => `${placeId}|${attribute}|${valueHash}`;

/** The review task subject of a deviation: one task per place, attribute and own value. */
export const comparisonSubjectId = (placeId: string, attribute: ComparisonAttribute, valueHash: string) =>
  `${placeId}:${attribute}:${valueHash}`;

/** An outcome was given for an own value that is no longer the place's current one: nothing is written. */
export class StaleComparison extends Error {
  constructor(placeId: string, attribute: ComparisonAttribute) {
    super(`the compared value of ${attribute} at place ${placeId} has changed`);
    this.name = "StaleComparison";
  }
}

const recordInputSchema = z.strictObject({
  subject: z.custom<ComparisonSubject>((v) => typeof v === "object" && v !== null),
  entries: z.array(entrySchema),
  evaluationRunId: z.uuid().optional(),
  method: z.enum(["proposal_auto", "proposal_confirmed", "manual"]),
  checkedBy: z.string().min(1),
  cfg: z.custom<QualityConfig["navily"]>((v) => typeof v === "object" && v !== null).optional(),
  now: z.date().optional(),
});

/**
 * Writes the outcomes of one place in one transaction. Each entry's `valueHash` must be the hash of the subject's
 * current own value (else `StaleComparison`, nothing written). An entry whose newest outcome for `(place, attribute,
 * valueHash)` is the same result or a review outcome is skipped (ruling M7-P16).
 *
 * Every written `deviation` opens a `comparison_deviation` task whose context holds only Periplus data: place,
 * attribute, value hash, profile version, evaluation run, the result row and `ownDisplay`, which is always
 * `comparisonValues(subject).display` (Grundprinzip 9: no caller-given text reaches the context). An open task for the
 * same value is reused and its context refreshed to the newest deviation; a written `match` dismisses the open task of
 * the same value (`dismissedReason` `resolved_by_match`; ruling M7-A-R1). `tasks` counts tasks newly opened.
 */
export async function recordComparisonResults(
  db: Db,
  input: {
    subject: ComparisonSubject;
    entries: Array<{
      attribute: ComparisonAttribute;
      result: "match" | "deviation" | "not_at_navily";
      valueHash: string;
      profileVersion: number | null;
    }>;
    evaluationRunId?: string;
    method: Exclude<ComparisonMethod, "review">;
    checkedBy: string;
    cfg?: QualityConfig["navily"];
    now?: Date;
  },
): Promise<{ written: number; tasks: number }> {
  const parsed = recordInputSchema.parse(input);
  const { subject, entries } = parsed;
  const placeId = subject.placeId;
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.attribute)) throw new Error(`attribute ${e.attribute} is given twice`);
    seen.add(e.attribute);
  }
  const values = comparisonValues(subject, parsed.cfg ?? getConfig().quality.navily);
  for (const e of entries) if (values[e.attribute].hash !== e.valueHash) throw new StaleComparison(placeId, e.attribute);
  if (entries.length === 0) return { written: 0, tasks: 0 };
  const now = parsed.now ?? new Date();
  const evaluationRunId = parsed.evaluationRunId ?? null;

  return db.transaction(async (tx) => {
    // concurrent recordings of the same place see each other's rows (the skip rule needs them)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`comparison:${placeId}`}))`);
    const latest = await latestComparisonResults(tx, [placeId]);
    let written = 0;
    let tasks = 0;
    for (const e of entries) {
      const previous = latest.get(key(placeId, e.attribute, e.valueHash));
      if (previous && (previous.result === e.result || REVIEW_OUTCOMES.has(previous.result))) continue;
      const [row] = await tx
        .insert(comparisonResults)
        .values({
          placeId,
          attribute: e.attribute,
          profileVersion: e.profileVersion,
          evaluationRunId,
          valueHash: e.valueHash,
          result: e.result,
          method: parsed.method,
          checkedBy: parsed.checkedBy,
          checkedAt: now,
        })
        .returning({ id: comparisonResults.id });
      written++;
      const subjectId = comparisonSubjectId(placeId, e.attribute, e.valueHash);
      if (e.result === "match") {
        await tx
          .update(reviewTasks)
          .set({ status: "dismissed", context: sql`${reviewTasks.context} || ${JSON.stringify({ dismissedReason: "resolved_by_match" })}::jsonb` })
          .where(and(eq(reviewTasks.kind, "comparison_deviation"), eq(reviewTasks.subjectId, subjectId), eq(reviewTasks.status, "open")));
      }
      if (e.result !== "deviation") continue;
      const context: ComparisonTaskContext = {
        placeId,
        attribute: e.attribute,
        valueHash: e.valueHash,
        profileVersion: e.profileVersion,
        evaluationRunId,
        resultId: row!.id,
        ownDisplay: values[e.attribute].display,
      };
      const task = await createReviewTask(tx, { kind: "comparison_deviation", subjectType: "comparison", subjectId, context });
      if (task.created) tasks++;
      else {
        // a repeated deviation (deviation → match → deviation) points the open task at the newest result
        await tx
          .update(reviewTasks)
          .set({ context })
          .where(and(eq(reviewTasks.id, task.id), eq(reviewTasks.status, "open")));
      }
    }
    return { written, tasks };
  });
}

export type LatestComparisonResult = {
  result: ComparisonResultValue;
  method: ComparisonMethod;
  checkedBy: string;
  checkedAt: Date;
  profileVersion: number | null;
  evaluationRunId: string | null;
};

/**
 * The newest outcome per `"<placeId>|<attribute>|<valueHash>"` of the places. An earlier outcome carries over to a
 * later profile only through the same value hash.
 */
export async function latestComparisonResults(db: Db, placeIds: string[]): Promise<Map<string, LatestComparisonResult>> {
  if (placeIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([comparisonResults.placeId, comparisonResults.attribute, comparisonResults.valueHash], {
      placeId: comparisonResults.placeId,
      attribute: comparisonResults.attribute,
      valueHash: comparisonResults.valueHash,
      result: comparisonResults.result,
      method: comparisonResults.method,
      checkedBy: comparisonResults.checkedBy,
      checkedAt: comparisonResults.checkedAt,
      profileVersion: comparisonResults.profileVersion,
      evaluationRunId: comparisonResults.evaluationRunId,
    })
    .from(comparisonResults)
    .where(inArray(comparisonResults.placeId, placeIds))
    .orderBy(
      comparisonResults.placeId,
      comparisonResults.attribute,
      comparisonResults.valueHash,
      desc(comparisonResults.checkedAt),
      desc(comparisonResults.createdAt),
      desc(comparisonResults.id),
    );
  return new Map(
    rows.map(({ placeId, attribute, valueHash, ...latest }) => [key(placeId, attribute, valueHash), latest]),
  );
}

/** The context of a `comparison_deviation` task as `recordComparisonResults` writes it. */
export const comparisonTaskContextSchema = z.strictObject({
  placeId: z.uuid(),
  attribute: z.enum(COMPARISON_ATTRIBUTES),
  valueHash: z.string().regex(VALUE_HASH),
  profileVersion: z.number().int().positive().nullable(),
  evaluationRunId: z.uuid().nullable(),
  resultId: z.uuid(),
  ownDisplay: z.string().nullable(),
  /** Set when a later match dismissed the task. */
  dismissedReason: z.literal("resolved_by_match").optional(),
});

export type ComparisonTaskContext = z.infer<typeof comparisonTaskContextSchema>;

/** Review decision on a deviation → the outcome it appends. */
export const COMPARISON_DECISION_OUTCOMES = {
  own_correct: "deviation_confirmed_own",
  navily_correct: "deviation_confirmed_navily",
  unclear: "unclear",
} as const satisfies Record<string, ComparisonResultValue>;

/**
 * Appends the outcome of a review decision on a deviation (inside the decision's transaction): same place,
 * attribute, value hash, profile version and evaluation run as the deviation, `method review`, decided by and the task.
 */
export async function appendReviewOutcome(
  tx: Db,
  input: {
    context: ComparisonTaskContext;
    action: keyof typeof COMPARISON_DECISION_OUTCOMES;
    taskId: string;
    decidedBy: string;
    now: Date;
  },
): Promise<void> {
  const c = input.context;
  await tx.insert(comparisonResults).values({
    placeId: c.placeId,
    attribute: c.attribute,
    profileVersion: c.profileVersion,
    evaluationRunId: c.evaluationRunId,
    valueHash: c.valueHash,
    result: COMPARISON_DECISION_OUTCOMES[input.action],
    method: "review",
    checkedBy: input.decidedBy,
    checkedAt: input.now,
    reviewTaskId: input.taskId,
  });
}
