import { desc, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import {
  COMPARISON_ATTRIBUTES,
  comparisonResults,
  type ComparisonAttribute,
  type ComparisonMethod,
  type ComparisonResultValue,
} from "@/lib/db/schema";
import { createReviewTask } from "@/lib/domain/review";

/*
 * Outcomes of the comparison against Navily (spec 10), append-only. Grundprinzip 9: an outcome, the hash of the own
 * value and its display are all that is written; a Navily value never reaches a row or a review context.
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

/**
 * Writes the outcomes of one place in one transaction. An entry whose newest outcome for `(place, attribute,
 * valueHash)` is the same result or a review outcome is skipped (ruling M7-P16). Every written `deviation` opens a
 * `comparison_deviation` task (or finds the open one) whose context holds only Periplus data: place, attribute, value
 * hash, profile version, evaluation run, the result row and the own value's display; the result row keeps
 * `review_task_id` empty (it is written first). `tasks` counts tasks newly opened.
 */
export async function recordComparisonResults(
  db: Db,
  input: {
    placeId: string;
    entries: Array<{
      attribute: ComparisonAttribute;
      result: "match" | "deviation" | "not_at_navily";
      valueHash: string;
      profileVersion: number | null;
    }>;
    evaluationRunId?: string;
    method: ComparisonMethod;
    checkedBy: string;
    display?: Partial<Record<ComparisonAttribute, string>>;
    now?: Date;
  },
): Promise<{ written: number; tasks: number }> {
  const entries = z.array(entrySchema).parse(input.entries);
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.attribute)) throw new Error(`attribute ${e.attribute} is given twice`);
    seen.add(e.attribute);
  }
  if (entries.length === 0) return { written: 0, tasks: 0 };
  const now = input.now ?? new Date();
  const evaluationRunId = input.evaluationRunId ?? null;

  return db.transaction(async (tx) => {
    // concurrent recordings of the same place see each other's rows (the skip rule needs them)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`comparison:${input.placeId}`}))`);
    const latest = await latestComparisonResults(tx, [input.placeId]);
    let written = 0;
    let tasks = 0;
    for (const e of entries) {
      const previous = latest.get(key(input.placeId, e.attribute, e.valueHash));
      if (previous && (previous.result === e.result || REVIEW_OUTCOMES.has(previous.result))) continue;
      const [row] = await tx
        .insert(comparisonResults)
        .values({
          placeId: input.placeId,
          attribute: e.attribute,
          profileVersion: e.profileVersion,
          evaluationRunId,
          valueHash: e.valueHash,
          result: e.result,
          method: input.method,
          checkedBy: input.checkedBy,
          checkedAt: now,
        })
        .returning({ id: comparisonResults.id });
      written++;
      if (e.result !== "deviation") continue;
      const task = await createReviewTask(tx, {
        kind: "comparison_deviation",
        subjectType: "comparison",
        subjectId: comparisonSubjectId(input.placeId, e.attribute, e.valueHash),
        context: {
          placeId: input.placeId,
          attribute: e.attribute,
          valueHash: e.valueHash,
          profileVersion: e.profileVersion,
          evaluationRunId,
          resultId: row!.id,
          ownDisplay: input.display?.[e.attribute] ?? null,
        },
      });
      if (task.created) tasks++;
    }
    return { written, tasks };
  });
}

export type LatestComparisonResult = {
  result: ComparisonResultValue;
  method: ComparisonMethod;
  checkedBy: string;
  checkedAt: Date;
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
    rows.map((r) => [key(r.placeId, r.attribute, r.valueHash), { result: r.result, method: r.method, checkedBy: r.checkedBy, checkedAt: r.checkedAt }]),
  );
}

/** The context of a `comparison_deviation` task as `recordComparisonResults` writes it. */
export const comparisonTaskContextSchema = z.object({
  placeId: z.uuid(),
  attribute: z.enum(COMPARISON_ATTRIBUTES),
  valueHash: z.string().regex(VALUE_HASH),
  profileVersion: z.number().int().positive().nullable(),
  evaluationRunId: z.uuid().nullable(),
  resultId: z.uuid(),
  ownDisplay: z.string().nullable(),
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
