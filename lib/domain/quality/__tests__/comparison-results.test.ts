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
import { insertNamedObject, insertTestRun } from "@/test/text";
import { latestComparisonResults, recordComparisonResults } from "../comparison-results";
import { loadComparisonSubjects } from "../comparison-values";

// Synthetic places at 21.0° E / 35.2° N (outside the pilot box), always rolled back.

const H1 = "0123456789abcdef";
const H2 = "fedcba9876543210";

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

/** One deviation on `shelter.N` (hash H1), as the assistant would write it. */
async function recordDeviation(tx: Db, placeId: string, opts: { evaluationRunId?: string } = {}) {
  return recordComparisonResults(tx, {
    placeId,
    entries: [{ attribute: "shelter.N", result: "deviation", valueHash: H1, profileVersion: opts.evaluationRunId ? null : 3 }],
    evaluationRunId: opts.evaluationRunId,
    method: "proposal_auto",
    checkedBy: "navily-assistant/1",
    display: { "shelter.N": "0,6 (geschützt)" },
  });
}

describe("comparison results", () => {
  it("a deviation opens one comparison_deviation task whose context holds no navily value", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const runId = await insertTestRun(tx);
      const out = await recordComparisonResults(tx, {
        placeId,
        entries: [
          { attribute: "existence", result: "match", valueHash: H2, profileVersion: null },
          { attribute: "shelter.N", result: "deviation", valueHash: H1, profileVersion: null },
          { attribute: "depth", result: "not_at_navily", valueHash: H2, profileVersion: null },
        ],
        evaluationRunId: runId,
        method: "manual",
        checkedBy: "admin@test",
        display: { "shelter.N": "0,6 (geschützt)" },
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
      const match = await recordComparisonResults(tx, {
        placeId,
        entries: [
          { attribute: "shelter.N", result: "match", valueHash: H1, profileVersion: 3 },
          { attribute: "shelter.S", result: "match", valueHash: H1, profileVersion: 3 },
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
      const base = { placeId, method: "manual" as const, checkedBy: "admin@test" };
      await expect(
        recordComparisonResults(tx, {
          ...base,
          entries: [
            { attribute: "depth", result: "match", valueHash: H1, profileVersion: 1 },
            { attribute: "depth", result: "deviation", valueHash: H2, profileVersion: 1 },
          ],
        }),
      ).rejects.toThrow(/depth/);
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
        valueHash: H1,
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
      const match = await recordComparisonResults(tx, {
        placeId,
        entries: [{ attribute: "shelter.N", result: "match", valueHash: H1, profileVersion: null }],
        method: "proposal_auto",
        checkedBy: "navily-assistant/1",
      });
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
        valueHash: H1,
        profileVersion: 3,
        evaluationRunId: null,
        ownDisplay: "0,6 (geschützt)",
      });
      expect(detailFeatures(detail!).features).toEqual([
        { type: "Feature", geometry: { type: "Point", coordinates: [21.0, 35.2] }, properties: { role: "subject", label: "Kolona" } },
      ]);
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
        .values({ kind: "comparison_deviation", subjectType: "comparison", subjectId: `${placeId}:depth:${H2}`, context: { placeId } })
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
      const write = (pid: string, attribute: "depth" | "seabed", result: "match" | "deviation", valueHash: string, now: Date) =>
        recordComparisonResults(tx, { placeId: pid, entries: [{ attribute, result, valueHash, profileVersion: 1 }], method: "manual", checkedBy: "a@test", now });
      await write(placeId, "depth", "match", H1, at("2026-10-01T10:00:00Z"));
      await write(placeId, "depth", "deviation", H1, at("2026-10-02T10:00:00Z"));
      await write(placeId, "depth", "match", H2, at("2026-10-01T10:00:00Z"));
      await write(placeId, "seabed", "match", H1, at("2026-10-03T10:00:00Z"));
      await write(other.placeId, "depth", "deviation", H1, at("2026-10-04T10:00:00Z"));

      const latest = await latestComparisonResults(tx, [placeId]);
      expect([...latest.keys()].sort()).toEqual([`${placeId}|depth|${H1}`, `${placeId}|depth|${H2}`, `${placeId}|seabed|${H1}`].sort());
      expect(latest.get(`${placeId}|depth|${H1}`)).toEqual({
        result: "deviation",
        method: "manual",
        checkedBy: "a@test",
        checkedAt: at("2026-10-02T10:00:00Z"),
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
