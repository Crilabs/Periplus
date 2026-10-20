import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { externalCalls, reviewDecisions, reviewTasks, runs, type ReviewKind, type RunScopeType } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { MODEL_COMPARISON_SCOPE } from "@/lib/pipeline/text/run";
import { insertProfile, provenanceEntry } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { quietDay } from "@/test/external-calls";
import { insertQualitySubdivision } from "@/test/quality";
import {
  costPerPlaceMetric,
  coverageMetric,
  highlightShareMetric,
  multiDocumentMetric,
  multiSourceMetric,
  placesPerTileMetric,
  recentObservationShareMetric,
  reviewEffortMetrics,
  shelterConfidenceMetric,
} from "../metrics";

// Quality metrics II on synthetic subdivisions at 21.0–22.0° E / 35.2° N (outside the pilot box), every row rolled back.
// Spend and review windows lie on a far-future day nobody else writes to (never counted DB-wide).

const quality = getConfig().quality;
const DAY_MS = 24 * 3_600_000;
const X = { lon: 21.01, lat: 35.2 };
const Y = { lon: 21.51, lat: 35.2 };
const Z = { lon: 21.76, lat: 35.2 };

async function window(tx: Db) {
  const from = await quietDay(tx);
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

async function insertRun(tx: Db, scopeType: RunScopeType, scopeId: string, o: { stages?: string[]; params?: Record<string, unknown> } = {}) {
  const [r] = await tx
    .insert(runs)
    .values({ kind: "stage", scopeType, scopeId, stages: o.stages ?? [], params: o.params ?? {}, triggeredBy: "test" })
    .returning({ id: runs.id });
  return r!.id;
}

async function call(tx: Db, at: Date, eur: number, o: { runId?: string; tileId?: string; stage?: string; service?: string } = {}) {
  await tx.insert(externalCalls).values({
    service: o.service ?? "anthropic",
    operation: "test",
    units: "1",
    unit: "request",
    costEur: eur.toFixed(6),
    runId: o.runId ?? null,
    tileId: o.tileId ?? null,
    stage: o.stage ?? "test.stage",
    at,
  });
}

describe("costPerPlaceMetric", () => {
  /** Subdivision X (3 places) with 3 € direct spend, subdivision Y (1 place) with none, 4 € shared spend, one-off and foreign spend. */
  async function scene(tx: Db) {
    const w = await window(tx);
    const at = new Date(w.from.getTime() + 3_600_000);
    const x = await insertQualitySubdivision(tx, [X]);
    const y = await insertQualitySubdivision(tx, [Y]);
    const z = await insertQualitySubdivision(tx, [Z]);
    const [px] = [await x.addPlace(), await x.addPlace(), await x.addPlace()];
    await x.addPlace({ status: "candidate" });
    await y.addPlace();
    await z.addPlace();
    // direct: a call of one of X's tiles, a call of a run of subdivision X, a call of a run of a place of X
    await call(tx, at, 1, { tileId: x.tileIds[0], stage: "discovery.tile", service: "dataforseo" });
    await call(tx, at, 1, { runId: await insertRun(tx, "subdivision", x.subdivisionKey), stage: "consolidation.followup", service: "dataforseo" });
    await call(tx, at, 1, { runId: await insertRun(tx, "place", px!.placeId), stage: "geometry.compute" });
    // shared: no run, a source run and a system text run
    await call(tx, at, 1);
    await call(tx, at, 1, { runId: await insertRun(tx, "source", newId()), stage: "fetch.url", service: "jina" });
    await call(tx, at, 2, { runId: await insertRun(tx, "system", "text-run"), stage: "extraction.mention" });
    // another subdivision's tile: neither direct nor shared for X
    await call(tx, at, 9, { tileId: z.tileIds[0] });
    // one-off pilot costs (ruling M7-P15)
    await call(tx, at, 5, { stage: "fixtures:record" });
    await call(tx, at, 6, { stage: "pdf:compare:2026-10-20T08:00:00.000Z" });
    await call(tx, at, 7, { runId: await insertRun(tx, "system", MODEL_COMPARISON_SCOPE), stage: "extraction.mention" });
    await call(tx, at, 8, { runId: await insertRun(tx, "system", "compare-converters", { stages: ["compare.converters"] }), stage: "compare.converters", service: "firecrawl" });
    await call(tx, at, 10, { runId: await insertRun(tx, "system", "evaluation", { params: { evaluation: true } }), stage: "extraction.mention" });
    return { w, x, y, z, subdivisionKeys: [x.subdivisionKey, y.subdivisionKey] };
  }

  it("cost per place adds the place share of shared costs", () =>
    withRollback(async (tx) => {
      const { w, x, y, subdivisionKeys } = await scene(tx);
      // X: (3 direct + 3/4 of 4 shared) / 3 places = 2.0
      const r = await costPerPlaceMetric(tx, { subdivisionKey: x.subdivisionKey }, w, { subdivisionKeys });
      expect(r.metric).toBe("cost_per_place");
      expect(r.value).toBeCloseTo(2.0);
      expect(r.details).toMatchObject({ costEur: 6, directEur: 3, sharedEur: 3, places: 3 });
      expect(r.details.byService).toEqual({ anthropic: 3.25, dataforseo: 2, jina: 0.75 });
      expect(r.details.byStage).toMatchObject({ "discovery.tile": 1, "consolidation.followup": 1, "geometry.compute": 1, "extraction.mention": 1.5 });
      expect(r.details.oneOff).toEqual({
        eur: 36,
        byKind: { fixturesRecord: 5, pdfCompare: 6, modelComparison: 7, converterComparison: 8, evaluation: 10 },
      });
      // Y: 1/4 of the shared spend for its one place
      expect((await costPerPlaceMetric(tx, { subdivisionKey: y.subdivisionKey }, w, { subdivisionKeys })).value).toBeCloseTo(1.0);
    }));

  it("calls outside the window do not count", () =>
    withRollback(async (tx) => {
      const { w, x, subdivisionKeys } = await scene(tx);
      await call(tx, w.to, 100, { tileId: x.tileIds[0] }); // the end is exclusive
      await call(tx, new Date(w.from.getTime() - 1), 100, { tileId: x.tileIds[0] });
      await call(tx, new Date(w.from.getTime() - 1), 100);
      expect((await costPerPlaceMetric(tx, { subdivisionKey: x.subdivisionKey }, w, { subdivisionKeys })).value).toBeCloseTo(2.0);
    }));

  it("a tile scope takes its direct spend, a share of the subdivision's untiled spend and of the shared spend", () =>
    withRollback(async (tx) => {
      const { w, x, subdivisionKeys } = await scene(tx);
      // the tile holds all 3 places of X: direct 1 (tile) + 1 (place run) + subdivision run 1 × 3/3 + shared 4 × 3/4
      const r = await costPerPlaceMetric(tx, { subdivisionKey: x.subdivisionKey, tileId: x.tileIds[0] }, w, { subdivisionKeys });
      expect(r.details).toMatchObject({ costEur: 6, directEur: 2, sharedEur: 4, places: 3 });
    }));

  it("no confirmed places is null", () =>
    withRollback(async (tx) => {
      const w = await window(tx);
      const empty = await insertQualitySubdivision(tx, [X]);
      expect(await costPerPlaceMetric(tx, { subdivisionKey: empty.subdivisionKey }, w, { subdivisionKeys: [empty.subdivisionKey] })).toMatchObject({
        metric: "cost_per_place",
        value: null,
        details: { places: 0 },
      });
    }));
});

describe("reviewEffortMetrics", () => {
  /** A task created at `at` with decisions of the given durations (null = no duration recorded). */
  async function task(
    tx: Db,
    at: Date,
    o: { kind?: ReviewKind; subjectType?: string; status?: "open" | "decided" | "dismissed"; durations?: Array<number | null> } = {},
  ) {
    const [t] = await tx
      .insert(reviewTasks)
      .values({ kind: o.kind ?? "place_candidate", subjectType: o.subjectType ?? "place", subjectId: newId(), status: o.status ?? "decided", createdAt: at })
      .returning({ id: reviewTasks.id });
    for (const durationMs of o.durations ?? []) {
      await tx.insert(reviewDecisions).values({ taskId: t!.id, decision: { action: "test" }, decidedBy: "test", durationMs });
    }
  }
  const MIN = 60_000;

  it("a decision open for 9 hours counts the cap of 10 minutes", () =>
    withRollback(async (tx) => {
      const w = await window(tx);
      const at = new Date(w.from.getTime() + 3_600_000);
      await task(tx, at, { durations: [9 * 60 * MIN] });
      await task(tx, at, { kind: "conflict", subjectType: "profile_attribute", durations: [2 * MIN] });
      await task(tx, w.to, { durations: [5 * MIN] }); // created after the window
      const [minutes] = await reviewEffortMetrics(tx, w, quality, { subdivisionKeys: [] });
      expect(minutes.metric).toBe("review_minutes");
      expect(minutes.value).toBe(10 + 2);
      expect(minutes.details.capped).toBe(1);
      expect(minutes.details).toMatchObject({ tasks: 2, decided: 2, open: 0, withoutDuration: 0 });
    }));

  it("decisions without duration count zero and are reported", () =>
    withRollback(async (tx) => {
      const w = await window(tx);
      const at = new Date(w.from.getTime() + 3_600_000);
      await task(tx, at, { durations: [null] });
      await task(tx, at, { durations: [3 * MIN] });
      await task(tx, at, { status: "open" });
      const [minutes] = await reviewEffortMetrics(tx, w, quality, { subdivisionKeys: [] });
      expect(minutes.value).toBe(3);
      expect(minutes.details).toMatchObject({ tasks: 3, decided: 2, open: 1, withoutDuration: 1, capped: 0 });
    }));

  it("removed profile entries and comparison deviations are reported apart, not counted (ruling M7-P14)", () =>
    withRollback(async (tx) => {
      const w = await window(tx);
      const at = new Date(w.from.getTime() + 3_600_000);
      await task(tx, at, { durations: [4 * MIN] });
      await task(tx, at, { kind: "uncertain_change", subjectType: "profile_entry", durations: [5 * MIN] });
      await task(tx, at, { kind: "comparison_deviation", subjectType: "comparison", durations: [6 * MIN] });
      const [minutes] = await reviewEffortMetrics(tx, w, quality, { subdivisionKeys: [] });
      expect(minutes.value).toBe(4);
      expect(minutes.details.tasks).toBe(1);
      expect(minutes.details.byKind).toEqual({
        place_candidate: { tasks: 1, decided: 1, minutes: 4, counted: true },
        profile_entry: { tasks: 1, decided: 1, minutes: 5, counted: false },
        comparison_deviation: { tasks: 1, decided: 1, minutes: 6, counted: false },
      });
    }));

  it("admin actions decided on creation (merge, position, anchor) are reported apart, not counted (ruling M7-D-R3)", () =>
    withRollback(async (tx) => {
      const w = await window(tx);
      const at = new Date(w.from.getTime() + 3_600_000);
      await task(tx, at, { durations: [4 * MIN] });
      await task(tx, at, { durations: [null] });
      const before = (await reviewEffortMetrics(tx, w, quality, { subdivisionKeys: [] }))[0];
      for (const subjectType of ["place_merge", "place_position", "place_anchor", "place_status"]) {
        await task(tx, at, { subjectType, durations: [null] });
      }
      const [minutes] = await reviewEffortMetrics(tx, w, quality, { subdivisionKeys: [] });
      expect(minutes.value).toBe(4);
      expect(minutes.details).toMatchObject({ tasks: 2, decided: 2, open: 0, withoutDuration: 1 });
      expect(minutes.details).toMatchObject({ tasks: before.details.tasks, withoutDuration: before.details.withoutDuration });
      expect(minutes.details.byKind).toEqual({
        place_candidate: { tasks: 2, decided: 2, minutes: 4, counted: true },
        place_merge: { tasks: 1, decided: 1, minutes: 0, counted: false },
        place_position: { tasks: 1, decided: 1, minutes: 0, counted: false },
        place_anchor: { tasks: 1, decided: 1, minutes: 0, counted: false },
        place_status: { tasks: 1, decided: 1, minutes: 0, counted: false },
      });
    }));

  it("review_minutes_per_100 relates to confirmed places", () =>
    withRollback(async (tx) => {
      const w = await window(tx);
      const at = new Date(w.from.getTime() + 3_600_000);
      const x = await insertQualitySubdivision(tx, [X]);
      const y = await insertQualitySubdivision(tx, [Y]);
      for (let i = 0; i < 3; i++) await x.addPlace();
      await x.addPlace({ status: "candidate" });
      await y.addPlace();
      await task(tx, at, { durations: [8 * MIN] });
      await task(tx, at, { durations: [4 * MIN] });
      const [minutes, per100] = await reviewEffortMetrics(tx, w, quality, { subdivisionKeys: [x.subdivisionKey, y.subdivisionKey] });
      expect(minutes.value).toBe(12);
      expect(per100.metric).toBe("review_minutes_per_100");
      expect(per100.value).toBeCloseTo((12 / 4) * 100);
      expect(per100.details).toEqual({ minutes: 12, places: 4 });
      // without confirmed places there is no rate
      expect((await reviewEffortMetrics(tx, w, quality, { subdivisionKeys: [] }))[1].value).toBeNull();
    }));
});

describe("highlightShareMetric", () => {
  it("highlight share counts present highlights only", () =>
    withRollback(async (tx) => {
      const a = await insertQualitySubdivision(tx, [X]);
      const present = await a.addPlace();
      await insertProfile(tx, present.geoObjectId, { "highlight.food": { present: true, names: [] } }, {});
      const absent = await a.addPlace();
      await insertProfile(tx, absent.geoObjectId, { "highlight.supply": { present: false, names: [] }, "services.water": true }, {});
      await a.addPlace(); // no profile
      // only the newest profile counts: the highlight disappeared in version 2
      const gone = await a.addPlace();
      await insertProfile(tx, gone.geoObjectId, { "highlight.food": { present: true, names: [] } }, {}, { version: 1 });
      await insertProfile(tx, gone.geoObjectId, {}, {}, { version: 2 });
      const candidate = await a.addPlace({ status: "candidate" });
      await insertProfile(tx, candidate.geoObjectId, { "highlight.food": { present: true, names: [] } }, {});
      const r = await highlightShareMetric(tx, { subdivisionKey: a.subdivisionKey });
      expect(r).toEqual({ metric: "highlight_share", value: 0.25, details: { places: 4, withHighlight: 1 } });
    }));
});

describe("recentObservationShareMetric", () => {
  const opts = { today: "2026-10-20", months: 18 };

  it("an observation 19 months old is not recent", () =>
    withRollback(async (tx) => {
      const a = await insertQualitySubdivision(tx, [X]);
      const add = async (origin: "text" | "observed" | "review" | "computed", observedAt: string) => {
        const p = await a.addPlace();
        await insertProfile(tx, p.geoObjectId, { "services.water": true }, { "services.water": provenanceEntry(origin, { observedAt }) });
      };
      await add("text", "2025-10-01");
      await add("text", "2025-03-20"); // 19 months before today
      await add("review", "2026-01-01");
      await add("observed", "2025-04-20"); // exactly 18 months: no longer „< 18 Monate“ (spec 10, ruling M7-D-R3)
      await add("observed", "2025-04-21"); // a day younger: recent
      await add("computed", "2026-10-01"); // not an observation
      const r = await recentObservationShareMetric(tx, { subdivisionKey: a.subdivisionKey }, opts);
      expect(r.metric).toBe("recent_observation_share");
      expect(r.value).toBeCloseTo(3 / 6);
      expect(r.details).toEqual({ places: 6, recent: 3, since: "2025-04-20" });
    }));
});

describe("placesPerTileMetric", () => {
  it("places per tile reports median and tiles outside 10–40", { timeout: 30_000 }, () =>
    withRollback(async (tx) => {
      const tilesAt = [X, { lon: 21.26, lat: 35.2 }, Y, { lon: 21.26, lat: 35.45 }];
      const a = await insertQualitySubdivision(tx, tilesAt);
      const fill = async (at: { lon: number; lat: number }, n: number) => {
        for (let i = 0; i < n; i++) await a.addPlace({ at });
      };
      await fill(tilesAt[0]!, 5);
      await fill(tilesAt[1]!, 12);
      await fill(tilesAt[2]!, 41);
      await a.addPlace({ at: tilesAt[1]!, status: "candidate" });
      // a tile without coast is no coast tile
      await fill(tilesAt[3]!, 20);
      await tx.execute(sql`update tiles set has_coast = false where id = ${a.tileIds[3]!}`);

      const r = await placesPerTileMetric(tx, a.subdivisionKey, quality);
      expect(r.metric).toBe("places_per_tile");
      expect(r.value).toBe(12);
      expect(r.details).toEqual({
        tiles: [
          { tileId: a.tileIds[0], places: 5 },
          { tileId: a.tileIds[1], places: 12 },
          { tileId: a.tileIds[2], places: 41 },
        ].sort((p, q) => (p.tileId < q.tileId ? -1 : 1)),
        min: 5,
        max: 41,
        median: 12,
        inTarget: 1,
        outsideTarget: [a.tileIds[0], a.tileIds[2]].sort(),
        target: { min: 10, max: 40 },
        endedTiles: [],
      });
    }));

  it("confirmed places in ended tiles are listed apart (ruling M7-D-R3)", () =>
    withRollback(async (tx) => {
      const a = await insertQualitySubdivision(tx, [X, Y]);
      await a.addPlace({ at: X });
      await a.addPlace({ at: Y });
      await a.addPlace({ at: Y });
      await a.addPlace({ at: Y, status: "candidate" });
      await tx.execute(sql`update tiles set valid_to = '2026-01-01' where id = ${a.tileIds[1]!}`);
      const r = await placesPerTileMetric(tx, a.subdivisionKey, quality, { today: "2026-10-20" });
      expect(r.details.tiles).toEqual([{ tileId: a.tileIds[0], places: 1 }]);
      expect(r.details.endedTiles).toEqual([{ tileId: a.tileIds[1], places: 2 }]);
    }));

  it("a subdivision without coast tiles is null", () =>
    withRollback(async (tx) => {
      expect((await placesPerTileMetric(tx, `test-${newId()}`, quality)).value).toBeNull();
    }));
});

describe("validity on the measurement date (ruling M7-D-R3)", () => {
  it("place and tile validity are judged on the given today, not on the database date", () =>
    withRollback(async (tx) => {
      const today = "2031-01-01";
      const a = await insertQualitySubdivision(tx, [X]);
      // valid only from 2030 on: valid on today, not yet on the database date
      for (let i = 0; i < 2; i++) {
        const p = await a.addPlace({ inSet: true });
        await tx.execute(sql`update places set valid_from = '2030-06-01' where id = ${p.placeId}`);
      }
      // ended before today, still valid on the database date
      const ended = await a.addPlace({ inSet: true });
      await tx.execute(sql`update places set valid_to = '2030-12-01' where id = ${ended.placeId}`);
      const scope = { subdivisionKey: a.subdivisionKey };
      const w = await window(tx);

      expect((await coverageMetric(tx, scope, { today })).details).toEqual({ set: 3, confirmed: 2 });
      expect((await multiSourceMetric(tx, scope, { today })).details.places).toBe(2);
      expect((await multiDocumentMetric(tx, scope, { today })).details.places).toBe(2);
      expect((await shelterConfidenceMetric(tx, scope, quality, { today })).details.places).toBe(2);
      expect((await costPerPlaceMetric(tx, scope, w, { subdivisionKeys: [a.subdivisionKey], today })).details.places).toBe(2);
      expect((await highlightShareMetric(tx, scope, { today })).details.places).toBe(2);
      expect((await recentObservationShareMetric(tx, scope, { today, months: 18 })).details.places).toBe(2);
      expect((await reviewEffortMetrics(tx, w, quality, { subdivisionKeys: [a.subdivisionKey], today }))[1].details.places).toBe(2);
      expect((await placesPerTileMetric(tx, a.subdivisionKey, quality, { today })).details.tiles).toEqual([{ tileId: a.tileIds[0], places: 2 }]);

      // a tile ended before today is no tile of the subdivision on today
      await tx.execute(sql`update tiles set valid_to = '2030-12-01' where id = ${a.tileIds[0]!}`);
      const r = await placesPerTileMetric(tx, a.subdivisionKey, quality, { today });
      expect(r.details).toMatchObject({ tiles: [], endedTiles: [{ tileId: a.tileIds[0], places: 2 }] });
    }));
});
