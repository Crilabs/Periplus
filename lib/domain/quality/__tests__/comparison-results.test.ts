import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { comparisonResults, comparisonSet, evaluationProfiles, places, reviewTasks } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { decideReviewTask, DecisionNotAllowed } from "@/lib/domain/review-decisions";
import { detailFeatures, reviewTaskDetail } from "@/lib/domain/review-view";
import { insertPlace, insertProfile, provenanceEntry } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { rowsWrittenInTransaction } from "@/test/quality";
import { insertNamedObject, insertTestRun } from "@/test/text";
import { getConfig } from "@/lib/config";
import { comparisonTaskContextSchema, latestComparisonResults, recordComparisonResults, StaleComparison } from "../comparison-results";
import { comparisonValues, loadComparisonSubjects, type ComparisonAttribute, type ComparisonSubject } from "../comparison-values";

// Synthetic places at 21.0° E / 35.2° N (outside the pilot box), always rolled back.

const cfg = getConfig().quality.navily;

/** The comparison subject of a test place: a confirmed anchorage at 21.0/35.2 with `shelter.N` 0.6 unless patched. */
function subjectOf(placeId: string, attributes: Record<string, unknown> = { "shelter.N": 0.6 }, patch: Partial<ComparisonSubject> = {}): ComparisonSubject {
  return {
    placeId,
    publicId: null,
    name: "Kolona",
    names: ["Kolona"],
    kind: "anchorage",
    status: "confirmed",
    position: { lon: 21.0, lat: 35.2 },
    anchorPosition: null,
    attributes,
    profileVersion: 3,
    ...patch,
  };
}

const hashOf = (s: ComparisonSubject, attribute: ComparisonAttribute) => comparisonValues(s, cfg)[attribute].hash;

async function resultsOf(tx: Db, placeId: string) {
  return tx.select().from(comparisonResults).where(eq(comparisonResults.placeId, placeId)).orderBy(comparisonResults.checkedAt, comparisonResults.id);
}

async function tasksOf(tx: Db, placeId: string) {
  return tx
    .select()
    .from(reviewTasks)
    .where(and(eq(reviewTasks.kind, "comparison_deviation"), eq(reviewTasks.subjectType, "comparison")))
    .then((rows) => rows.filter((r) => r.subjectId.startsWith(`${placeId}:`)));
}

/** One result on `shelter.N` (own value 0.6), as the assistant would write it; a deviation by default. */
async function recordShelterN(tx: Db, placeId: string, opts: { evaluationRunId?: string; result?: "match" | "deviation" } = {}) {
  const subject = subjectOf(placeId);
  return recordComparisonResults(tx, {
    subject,
    entries: [
      { attribute: "shelter.N", result: opts.result ?? "deviation", valueHash: hashOf(subject, "shelter.N"), profileVersion: opts.evaluationRunId ? null : 3 },
    ],
    evaluationRunId: opts.evaluationRunId,
    method: "proposal_auto",
    checkedBy: "navily-assistant/1",
  });
}
const recordDeviation = (tx: Db, placeId: string, opts: { evaluationRunId?: string } = {}) => recordShelterN(tx, placeId, opts);

describe("comparison results", () => {
  it("a deviation opens one comparison_deviation task whose context holds no navily value", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const runId = await insertTestRun(tx);
      const subject = subjectOf(placeId, { "shelter.N": 0.6 }, { profileVersion: null });
      const out = await recordComparisonResults(tx, {
        subject,
        entries: [
          { attribute: "existence", result: "match", valueHash: hashOf(subject, "existence"), profileVersion: null },
          { attribute: "shelter.N", result: "deviation", valueHash: hashOf(subject, "shelter.N"), profileVersion: null },
          { attribute: "depth", result: "not_at_navily", valueHash: hashOf(subject, "depth"), profileVersion: null },
        ],
        evaluationRunId: runId,
        method: "manual",
        checkedBy: "admin@test",
      });
      expect(out).toEqual({ written: 3, tasks: 1 });

      const rows = await resultsOf(tx, placeId);
      expect(rows.map((r) => [r.attribute, r.result, r.method, r.checkedBy, r.evaluationRunId, r.reviewTaskId])).toEqual(
        expect.arrayContaining([
          ["existence", "match", "manual", "admin@test", runId, null],
          ["shelter.N", "deviation", "manual", "admin@test", runId, null],
          ["depth", "not_at_navily", "manual", "admin@test", runId, null],
        ]),
      );
      const deviation = rows.find((r) => r.result === "deviation")!;

      const [task, ...more] = await tasksOf(tx, placeId);
      expect(more).toEqual([]);
      const H1 = hashOf(subject, "shelter.N");
      expect(task!.subjectId).toBe(`${placeId}:shelter.N:${H1}`);
      expect(task!.status).toBe("open");
      expect(Object.keys(task!.context as object).sort()).toEqual(
        ["attribute", "evaluationRunId", "ownDisplay", "placeId", "profileVersion", "resultId", "valueHash"].sort(),
      );
      expect(task!.context).toEqual({
        placeId,
        attribute: "shelter.N",
        valueHash: H1,
        profileVersion: null,
        evaluationRunId: runId,
        resultId: deviation.id,
        ownDisplay: "0,6 (geschützt)",
      });
    });
  });

  it("recording the same result again writes nothing", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      expect(await recordDeviation(tx, placeId)).toEqual({ written: 1, tasks: 1 });
      expect(await recordDeviation(tx, placeId)).toEqual({ written: 0, tasks: 0 });
      expect(await resultsOf(tx, placeId)).toHaveLength(1);
      // another result for the same value is written; a deviation on another value hash too
      const subject = subjectOf(placeId);
      const match = await recordComparisonResults(tx, {
        subject,
        entries: [
          { attribute: "shelter.N", result: "match", valueHash: hashOf(subject, "shelter.N"), profileVersion: 3 },
          { attribute: "shelter.S", result: "match", valueHash: hashOf(subject, "shelter.S"), profileVersion: 3 },
        ],
        method: "proposal_confirmed",
        checkedBy: "admin@test",
      });
      expect(match).toEqual({ written: 2, tasks: 0 });
      expect(await resultsOf(tx, placeId)).toHaveLength(3);
    });
  });

  it("refuses an attribute twice, an unknown attribute or a review outcome as entry", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const subject = subjectOf(placeId, { "depth.min": 4 });
      const H1 = hashOf(subject, "depth");
      const H2 = "fedcba9876543210";
      const base = { subject, method: "manual" as const, checkedBy: "admin@test" };
      await expect(
        recordComparisonResults(tx, {
          ...base,
          entries: [
            { attribute: "depth", result: "match", valueHash: H1, profileVersion: 1 },
            { attribute: "depth", result: "deviation", valueHash: H1, profileVersion: 1 },
          ],
        }),
      ).rejects.toThrow(/depth/);
      // a hash that is not the subject's current value is stale
      await expect(
        recordComparisonResults(tx, { ...base, entries: [{ attribute: "depth", result: "match", valueHash: H2, profileVersion: 1 }] }),
      ).rejects.toBeInstanceOf(StaleComparison);
      await expect(
        recordComparisonResults(tx, {
          ...base,
          // @ts-expect-error not a comparison attribute
          entries: [{ attribute: "rating", result: "match", valueHash: H1, profileVersion: 1 }],
        }),
      ).rejects.toThrow();
      await expect(
        recordComparisonResults(tx, {
          ...base,
          // @ts-expect-error a review outcome is written by the review decision only
          entries: [{ attribute: "depth", result: "deviation_confirmed_own", valueHash: H1, profileVersion: 1 }],
        }),
      ).rejects.toThrow();
      expect(await resultsOf(tx, placeId)).toEqual([]);
    });
  });

  it.each([
    ["own_correct", "deviation_confirmed_own"],
    ["navily_correct", "deviation_confirmed_navily"],
    ["unclear", "unclear"],
  ] as const)("%s appends %s with method review and the task id", async (action, outcome) => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const runId = await insertTestRun(tx);
      await recordDeviation(tx, placeId, { evaluationRunId: runId });
      const [task] = await tasksOf(tx, placeId);

      const result = await decideReviewTask(tx, { taskId: task!.id, decision: { action }, decidedBy: "admin@test" });
      expect(result).toEqual({ documentVersionIds: [], consolidate: null });

      const rows = await resultsOf(tx, placeId);
      expect(rows).toHaveLength(2);
      const [first, decided] = rows as [(typeof rows)[0], (typeof rows)[0]];
      expect(decided).toMatchObject({
        placeId,
        attribute: "shelter.N",
        valueHash: first.valueHash,
        profileVersion: first.profileVersion,
        evaluationRunId: runId,
        result: outcome,
        method: "review",
        checkedBy: "admin@test",
        reviewTaskId: task!.id,
      });
      const [after] = await tasksOf(tx, placeId);
      expect(after!.status).toBe("decided");

      // a rerun of the proposals never supersedes the decision (ruling M7-P16): nothing written, no task
      expect(await recordDeviation(tx, placeId, { evaluationRunId: runId })).toEqual({ written: 0, tasks: 0 });
      const match = await recordShelterN(tx, placeId, { evaluationRunId: runId, result: "match" });
      expect(match).toEqual({ written: 0, tasks: 0 });
      expect(await tasksOf(tx, placeId)).toHaveLength(1);
    });
  });

  it("the review view shows the place, the attribute and the own value only", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      await recordDeviation(tx, placeId);
      const [task] = await tasksOf(tx, placeId);
      const detail = await reviewTaskDetail(tx, task!.id);
      expect(detail!.subject).toEqual({
        type: "comparison",
        place: { id: placeId, publicId: null, name: "Kolona", kind: "anchorage", status: "confirmed", position: { lon: 21.0, lat: 35.2 } },
        attribute: "shelter.N",
        valueHash: hashOf(subjectOf(placeId), "shelter.N"),
        profileVersion: 3,
        evaluationRunId: null,
        ownDisplay: "0,6 (geschützt)",
      });
      expect(detailFeatures(detail!).features).toEqual([
        { type: "Feature", geometry: { type: "Point", coordinates: [21.0, 35.2] }, properties: { role: "subject", label: "Kolona" } },
      ]);
    });
  });

  it("a deviation on a value with an open task refreshes that task to the newest result (ruling M7-A-R1)", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const runId = await insertTestRun(tx);
      const subject = subjectOf(placeId);
      const H = hashOf(subject, "shelter.N");
      // an open task without a deviation row of its own (e.g. a recording that raced it)
      await tx.insert(reviewTasks).values({
        kind: "comparison_deviation",
        subjectType: "comparison",
        subjectId: `${placeId}:shelter.N:${H}`,
        context: { placeId, attribute: "shelter.N", valueHash: H, profileVersion: 3, evaluationRunId: null, resultId: placeId, ownDisplay: "alt" },
      });
      const out = await recordComparisonResults(tx, {
        subject,
        entries: [{ attribute: "shelter.N", result: "deviation", valueHash: H, profileVersion: null }],
        evaluationRunId: runId,
        method: "manual",
        checkedBy: "admin@test",
      });
      expect(out).toEqual({ written: 1, tasks: 0 });
      const [task, ...more] = await tasksOf(tx, placeId);
      expect(more).toEqual([]);
      const [row] = await resultsOf(tx, placeId);
      expect(task!.context).toEqual({
        placeId,
        attribute: "shelter.N",
        valueHash: H,
        profileVersion: null,
        evaluationRunId: runId,
        resultId: row!.id,
        ownDisplay: "0,6 (geschützt)",
      });
    });
  });

  it.each([
    ["match", "resolved_by_match"],
    ["not_at_navily", "resolved_by_not_at_navily"],
  ] as const)("a written %s dismisses every open deviation task of the place and attribute, of any value (%s)", async (result, reason) => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const record = (subject: ComparisonSubject, attribute: ComparisonAttribute, r: "match" | "deviation" | "not_at_navily", minute: number) =>
        recordComparisonResults(tx, {
          subject,
          entries: [{ attribute, result: r, valueHash: hashOf(subject, attribute), profileVersion: subject.profileVersion }],
          method: "manual",
          checkedBy: "admin@test",
          now: new Date(Date.UTC(2026, 9, 1, 10, minute)),
        });
      const v1 = subjectOf(placeId, { "shelter.N": 0.6, "shelter.NE": 0.6 });
      const v2 = subjectOf(placeId, { "shelter.N": 0.3, "shelter.NE": 0.6 }, { profileVersion: 4 });
      // deviations on shelter.N for two own values, and one on shelter.NE
      expect(await record(v1, "shelter.N", "deviation", 0)).toEqual({ written: 1, tasks: 1 });
      expect(await record(v2, "shelter.N", "deviation", 1)).toEqual({ written: 1, tasks: 1 });
      expect(await record(v1, "shelter.NE", "deviation", 2)).toEqual({ written: 1, tasks: 1 });

      // the newest value of shelter.N is settled: both shelter.N tasks close, shelter.NE stays open
      expect(await record(v2, "shelter.N", result, 3)).toEqual({ written: 1, tasks: 0 });
      const tasks = await tasksOf(tx, placeId);
      const byAttribute = (attribute: string) => tasks.filter((t) => (t.context as { attribute: string }).attribute === attribute);
      expect(byAttribute("shelter.N").map((t) => t.status)).toEqual(["dismissed", "dismissed"]);
      for (const t of byAttribute("shelter.N")) expect(comparisonTaskContextSchema.parse(t.context).dismissedReason).toBe(reason);
      expect(byAttribute("shelter.NE").map((t) => t.status)).toEqual(["open"]);

      // a deviation after that opens a new task
      expect(await record(v2, "shelter.N", "deviation", 4)).toEqual({ written: 1, tasks: 1 });
    });
  });

  it("a regular match leaves the open deviation task of an evaluation run open (final review B I-1)", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const runId = await insertTestRun(tx);
      const regular = subjectOf(placeId, { "shelter.N": 0.6 });
      const candidate = subjectOf(placeId, { "shelter.N": 0.3 }, { profileVersion: null });
      // the evaluation of a candidate configuration finds a deviation on its changed value
      const evaluation = await recordComparisonResults(tx, {
        subject: candidate,
        entries: [{ attribute: "shelter.N", result: "deviation", valueHash: hashOf(candidate, "shelter.N"), profileVersion: null }],
        evaluationRunId: runId,
        method: "manual",
        checkedBy: "admin@test",
        now: new Date(Date.UTC(2026, 9, 1, 10, 0)),
      });
      expect(evaluation).toEqual({ written: 1, tasks: 1 });
      // the regular page confirms the place's own (unchanged) value: settles the regular value only
      await recordComparisonResults(tx, {
        subject: regular,
        entries: [{ attribute: "shelter.N", result: "match", valueHash: hashOf(regular, "shelter.N"), profileVersion: 3 }],
        method: "manual",
        checkedBy: "admin@test",
        now: new Date(Date.UTC(2026, 9, 1, 10, 1)),
      });
      const [task, ...more] = await tasksOf(tx, placeId);
      expect(more).toEqual([]);
      expect(task!.status).toBe("open");
      expect(comparisonTaskContextSchema.parse(task!.context).evaluationRunId).toBe(runId);
    });
  });

  it("a repeated deviation whose task was dismissed opens a task again instead of being skipped (final review B I-1)", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const record = (subject: ComparisonSubject, r: "match" | "deviation", minute: number) =>
        recordComparisonResults(tx, {
          subject,
          entries: [{ attribute: "shelter.N", result: r, valueHash: hashOf(subject, "shelter.N"), profileVersion: subject.profileVersion }],
          method: "manual",
          checkedBy: "admin@test",
          now: new Date(Date.UTC(2026, 9, 1, 10, minute)),
        });
      const v1 = subjectOf(placeId, { "shelter.N": 0.6 });
      const v2 = subjectOf(placeId, { "shelter.N": 0.3 }, { profileVersion: 4 });
      const v3 = subjectOf(placeId, { "shelter.N": 0.6 }, { profileVersion: 5 });
      expect(await record(v1, "deviation", 0)).toEqual({ written: 1, tasks: 1 });
      // a match on a newer value dismisses the old value's task
      expect(await record(v2, "match", 1)).toEqual({ written: 1, tasks: 0 });
      expect((await tasksOf(tx, placeId)).map((t) => t.status)).toEqual(["dismissed"]);
      // the value reverts and deviates again: its deviation must be reviewable
      expect(await record(v3, "deviation", 2)).toEqual({ written: 1, tasks: 1 });
      const tasks = await tasksOf(tx, placeId);
      expect(tasks.map((t) => t.status).sort()).toEqual(["dismissed", "open"]);
      const open = tasks.find((t) => t.status === "open")!;
      const rows = await resultsOf(tx, placeId);
      expect(comparisonTaskContextSchema.parse(open.context)).toMatchObject({ resultId: rows.at(-1)!.id, profileVersion: 5 });
      // with the task open, the same deviation again is skipped
      expect(await record(v3, "deviation", 3)).toEqual({ written: 0, tasks: 0 });
    });
  });

  it("the task context takes the own display from the subject only; a caller-given display is refused", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const subject = subjectOf(placeId);
      const entries = [{ attribute: "shelter.N" as const, result: "deviation" as const, valueHash: hashOf(subject, "shelter.N"), profileVersion: 3 }];
      await expect(
        recordComparisonResults(tx, {
          subject,
          entries,
          method: "manual",
          checkedBy: "admin@test",
          // @ts-expect-error the own display is never given by the caller (Grundprinzip 9)
          display: { "shelter.N": "NAVILY-ONLY-NAME" },
        }),
      ).rejects.toThrow();
      await recordComparisonResults(tx, { subject, entries, method: "manual", checkedBy: "admin@test" });
      const [task] = await tasksOf(tx, placeId);
      expect((task!.context as { ownDisplay: string }).ownDisplay).toBe(comparisonValues(subject, cfg)["shelter.N"].display);
      expect(await resultsOf(tx, placeId)).toHaveLength(1);
      // every row this transaction wrote, of any place or subject
      expect((await rowsWrittenInTransaction(tx)).join("\n")).not.toMatch(/NAVILY-ONLY-NAME/);
      // the context schema is strict: an extra key (a navily value smuggled in) is refused
      expect(comparisonTaskContextSchema.safeParse({ ...(task!.context as object), navilyName: "NAVILY-ONLY-NAME" }).success).toBe(false);
    });
  });

  it("comparison decisions fit only comparison_deviation tasks", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      await recordDeviation(tx, placeId);
      const [task] = await tasksOf(tx, placeId);
      await expect(
        tx.transaction((sp) => decideReviewTask(sp, { taskId: task!.id, decision: { action: "ignore" }, decidedBy: "admin@test" })),
      ).rejects.toBeInstanceOf(DecisionNotAllowed);
      // a broken context is refused, nothing is written
      const [broken] = await tx
        .insert(reviewTasks)
        .values({ kind: "comparison_deviation", subjectType: "comparison", subjectId: `${placeId}:depth:fedcba9876543210`, context: { placeId } })
        .returning({ id: reviewTasks.id });
      await expect(
        tx.transaction((sp) => decideReviewTask(sp, { taskId: broken!.id, decision: { action: "own_correct" }, decidedBy: "admin@test" })),
      ).rejects.toBeInstanceOf(DecisionNotAllowed);
      expect(await resultsOf(tx, placeId)).toHaveLength(1);
    });
  });

  it("latestComparisonResults returns the newest result per place, attribute and hash", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const other = await insertPlace(tx, { lon: 21.01, name: "Other" });
      const at = (iso: string) => new Date(iso);
      // depth 4 m (H1) and 6 m (H2): two own values of the same attribute
      const write = (pid: string, attribute: "depth" | "seabed", result: "match" | "deviation", depth: number, now: Date) => {
        const subject = subjectOf(pid, { "depth.min": depth });
        return recordComparisonResults(tx, {
          subject,
          entries: [{ attribute, result, valueHash: hashOf(subject, attribute), profileVersion: 1 }],
          method: "manual",
          checkedBy: "a@test",
          now,
        });
      };
      const H1 = hashOf(subjectOf(placeId, { "depth.min": 4 }), "depth");
      const H2 = hashOf(subjectOf(placeId, { "depth.min": 6 }), "depth");
      const S1 = hashOf(subjectOf(placeId), "seabed");
      await write(placeId, "depth", "match", 4, at("2026-10-01T10:00:00Z"));
      await write(placeId, "depth", "deviation", 4, at("2026-10-02T10:00:00Z"));
      await write(placeId, "depth", "match", 6, at("2026-10-01T10:00:00Z"));
      await write(placeId, "seabed", "match", 4, at("2026-10-03T10:00:00Z"));
      await write(other.placeId, "depth", "deviation", 4, at("2026-10-04T10:00:00Z"));

      const latest = await latestComparisonResults(tx, [placeId]);
      expect([...latest.keys()].sort()).toEqual([`${placeId}|depth|${H1}`, `${placeId}|depth|${H2}`, `${placeId}|seabed|${S1}`].sort());
      expect(latest.get(`${placeId}|depth|${H1}`)).toEqual({
        result: "deviation",
        method: "manual",
        checkedBy: "a@test",
        checkedAt: at("2026-10-02T10:00:00Z"),
        profileVersion: 1,
        evaluationRunId: null,
      });
      expect(latest.get(`${placeId}|depth|${H2}`)?.result).toBe("match");
      expect(await latestComparisonResults(tx, [])).toEqual(new Map());
    });
  });

  it("loadComparisonSubjects reads evaluation profiles for an evaluation run", async () => {
    await withRollback(async (tx) => {
      const areaKey = `test-${newId()}`;
      const areaId = await insertNamedObject(tx, { type: "area", names: [{ name: "Test area" }], lon: 21.0, lat: 35.2, configKey: areaKey });
      const objectId = await insertNamedObject(tx, {
        type: "bay",
        names: [{ name: "Kolona" }, { name: "Κολώνα", language: "el" }],
        lon: 21.0,
        lat: 35.2,
      });
      const [place] = await tx
        .insert(places)
        .values({ geoObjectId: objectId, kind: "anchorage", status: "confirmed", position: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] }) })
        .returning({ id: places.id });
      const outside = await insertPlace(tx, { lon: 21.02, name: "Not in the set" });
      await tx.insert(comparisonSet).values({ placeId: place!.id, areaId, addedBy: "test" });
      await insertProfile(
        tx,
        objectId,
        { "shelter.N": 0.3, "place.position": { lon: 21.00001, lat: 35.20001 } },
        { "shelter.N": provenanceEntry("computed") },
        { version: 2 },
      );
      const runId = await insertTestRun(tx);
      await tx.insert(evaluationProfiles).values({
        runId,
        geoObjectId: objectId,
        rulesVersion: "v2",
        factSchemaVersion: "v2",
        attributes: { "shelter.N": 0.7, "place.position": { lon: 21.00002, lat: 35.20002 }, anchor_position: { lon: 21.001, lat: 35.201 } },
        provenance: {},
        contentHash: "h",
      });

      const current = await loadComparisonSubjects(tx, areaKey);
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({
        placeId: place!.id,
        name: "Kolona",
        kind: "anchorage",
        status: "confirmed",
        position: { lon: 21.00001, lat: 35.20001 },
        anchorPosition: null,
        attributes: { "shelter.N": 0.3 },
        profileVersion: 2,
      });
      expect(current[0]!.names).toEqual(expect.arrayContaining(["Kolona", "Κολώνα"]));
      expect(current.map((s) => s.placeId)).not.toContain(outside.placeId);

      const evaluated = await loadComparisonSubjects(tx, areaKey, { evaluationRunId: runId });
      expect(evaluated[0]).toMatchObject({
        position: { lon: 21.00002, lat: 35.20002 },
        anchorPosition: { lon: 21.001, lat: 35.201 },
        attributes: { "shelter.N": 0.7 },
        profileVersion: null,
      });
      // without an evaluation profile the attributes are empty and the place position is used
      const otherRun = await insertTestRun(tx);
      expect((await loadComparisonSubjects(tx, areaKey, { evaluationRunId: otherRun }))[0]).toMatchObject({
        position: { lon: 21.0, lat: 35.2 },
        attributes: {},
        profileVersion: null,
      });
      expect(await loadComparisonSubjects(tx, `test-${newId()}`)).toEqual([]);
    });
  });
});
