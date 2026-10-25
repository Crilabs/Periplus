import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { comparisonResults, comparisonSet, evaluationProfiles, places, reviewTasks, runs } from "@/lib/db/schema";
import { createRun } from "@/lib/domain/runs";
import { CONSOLIDATION_GEO_STAGE } from "@/lib/pipeline/consolidation/stages";
import { comparisonValues, loadComparisonSubjects } from "@/lib/domain/quality/comparison-values";
import { subdivisionComparisonView } from "@/lib/domain/quality/navily-compare";
import { loadNavilySpots } from "@/lib/domain/quality/navily-sample";
import { getConfig } from "@/lib/config";
import { insertBerthState } from "@/test/berth-state";
import { testDb, withRollback } from "@/test/db";
import { NAVILY_MARKERS, rowsWrittenInTransaction } from "@/test/quality";
import { insertNamedObject, insertTestSubdivision } from "@/test/text";

const db = testDb();
let currentDb: Db = db;
const requireAdmin = vi.fn();
/** The Navily file the actions see (ruling M7-P3: passed as the env parameter); null = NAVILY_SPOTS_PATH unset. */
let navilyPath: string | null = null;

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => currentDb,
}));
vi.mock("@/lib/domain/quality/navily-assistant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain/quality/navily-assistant")>();
  return { ...actual, loadNavilyFromEnv: () => actual.loadNavilyFromEnv({ NAVILY_SPOTS_PATH: navilyPath ?? undefined }) };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
/** The database handles the comparison set was loaded with (the write transaction must be one of its own). */
const subjectLoads: Db[] = [];
vi.mock("@/lib/domain/quality/comparison-values", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain/quality/comparison-values")>();
  return {
    ...actual,
    loadComparisonSubjects: (db: Db, ...rest: Parameters<typeof actual.loadComparisonSubjects> extends [Db, ...infer R] ? R : never) => {
      subjectLoads.push(db);
      return actual.loadComparisonSubjects(db, ...rest);
    },
  };
});

import { acceptProposalsAction, recordComparisonAction } from "../quality/compare/actions";

const FIXTURE = path.join(process.cwd(), "test/fixtures/navily/sample.json");
/** The key of the test subdivision `setUp` inserts (rolled back, so a fixed key is safe). */
const SUBDIVISION = "XT-compare-actions";
const ADMIN = "admin@example.invalid";
/** The coordinates of the fixture's first spot, about 43 m off the place, in every form a leak could take. */
const SPOT_COORDINATES = /35[.,]2003|21[.,]0003/;
/** The keys a typed action result may carry: codes and counts only. */
const RESULT_KEYS = new Set(["ok", "code", "written", "tasks", "skippedManual"]);

function expectCodesAndCounts(result: object) {
  expect(Object.keys(result).every((k) => RESULT_KEYS.has(k))).toBe(true);
  expect(Object.values(result).every((v) => typeof v === "boolean" || typeof v === "number" || /^[a-z_]+$/.test(String(v)))).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(NAVILY_MARKERS);
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "navily-actions-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetAllMocks();
  currentDb = db;
  navilyPath = FIXTURE;
  subjectLoads.length = 0;
  requireAdmin.mockResolvedValue({ email: ADMIN });
});

/**
 * A confirmed anchorage at 21.0° E / 35.2° N (about 43 m from the fixture's first spot, outside the pilot box) in the
 * comparison set of the test subdivision, rolled back. Its values agree with the spot except `services.water` (own false, Navily true).
 */
async function setUp(tx: Db) {
  currentDb = tx;
  const { id: subdivisionId } = await insertTestSubdivision(tx, SUBDIVISION, [20.5, 34.7, 21.5, 35.7]);
  const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.0, lat: 35.2, subdivisionId });
  const [place] = await tx
    .insert(places)
    .values({ geoObjectId: objectId, kind: "anchorage", status: "confirmed", position: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] }) })
    .returning({ id: places.id });
  await tx.insert(comparisonSet).values({ placeId: place!.id, subdivisionId, addedBy: "test" });
  const attributes = {
    "place.position": { lon: 21.0, lat: 35.2 },
    "shelter.N": 0.9,
    "shelter.NE": 0.8,
    "shelter.E": 0.1,
    "shelter.SE": 0.1,
    "shelter.S": 0.1,
    "shelter.SW": 0.1,
    "shelter.W": 0.1,
    "shelter.NW": 0.7,
    seabed: [
      { type: "weed", share: 0.6 },
      { type: "sand", share: 0.4 },
    ],
    "mooring.buoys": { present: true, count: 8 },
    "services.water": false,
    "highlight.supply": { present: false },
  };
  // the berth state carries the core values only; position and supply come from the place and its surroundings
  const { "place.position": _position, "highlight.supply": _supply, ...core } = attributes; // eslint-disable-line @typescript-eslint/no-unused-vars
  await insertBerthState(tx, place!.id, core);
  return { placeId: place!.id };
}

const resultsOf = (tx: Db, placeId: string) => tx.select().from(comparisonResults).where(eq(comparisonResults.placeId, placeId));
const tasksOf = (tx: Db, placeId: string) =>
  tx
    .select()
    .from(reviewTasks)
    .where(and(eq(reviewTasks.kind, "comparison_deviation"), sql`${reviewTasks.subjectId} like ${`${placeId}:%`}`));

/** The digest of the proposals the page shows for the place. */
async function shownDigest(tx: Db, placeId: string): Promise<string> {
  const config = getConfig();
  const view = await subdivisionComparisonView(tx, {
    subdivisionKey: SUBDIVISION,
    spots: await loadNavilySpots(FIXTURE),
    cfg: config.quality.navily,
    affixes: config.nameAffixes,
  });
  return view.places.find((p) => p.subject.placeId === placeId)!.digest!;
}

async function accept(tx: Db, placeId: string) {
  return acceptProposalsAction({ placeId, subdivisionKey: SUBDIVISION, digest: await shownDigest(tx, placeId) });
}

async function currentHash(tx: Db, placeId: string, attribute: "services.water" | "depth") {
  const subject = (await loadComparisonSubjects(tx, SUBDIVISION)).find((s) => s.placeId === placeId)!;
  return comparisonValues(subject, getConfig().quality.navily)[attribute].hash;
}

describe("/quality/compare actions", () => {
  it("acceptProposalsAction writes one result per attribute with method proposal_confirmed", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const r = await accept(tx, placeId);
      expect(r).toEqual({ ok: true, written: 16, tasks: 1, skippedManual: 0 });
      expectCodesAndCounts(r);
      const rows = await resultsOf(tx, placeId);
      expect(rows).toHaveLength(16);
      expect(rows.every((x) => x.method === "proposal_confirmed" && x.checkedBy === ADMIN)).toBe(true);
      expect(rows.every((x) => x.profileVersion === null && x.evaluationRunId === null)).toBe(true);
      const byAttribute = Object.fromEntries(rows.map((x) => [x.attribute, x.result]));
      expect(byAttribute).toMatchObject({
        existence: "match",
        position: "match",
        "shelter.N": "match",
        "shelter.S": "match",
        depth: "not_at_navily",
        seabed: "match",
        "mooring.buoys": "match",
        "services.water": "deviation",
        "highlight.supply": "match",
        "highlight.food": "not_at_navily",
      });
    }));

  it("a second accept writes nothing", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      await accept(tx, placeId);
      expect(await accept(tx, placeId)).toEqual({ ok: true, written: 0, tasks: 0, skippedManual: 0 });
      expect(await resultsOf(tx, placeId)).toHaveLength(16);
    }));

  it("a deviation proposal opens one review task; no navily value or coordinate reaches any row the transaction wrote", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const r = await accept(tx, placeId);
      expect(r).toMatchObject({ ok: true, tasks: 1 });
      const tasks = await tasksOf(tx, placeId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.context).toMatchObject({ attribute: "services.water", ownDisplay: "nein", profileVersion: null });
      // Grundprinzip 9: every row this transaction wrote, of any place or subject
      const written = await rowsWrittenInTransaction(tx);
      expect(written.length).toBeGreaterThanOrEqual(17);
      expect(written.join("\n")).not.toMatch(NAVILY_MARKERS);
      expect(written.join("\n")).not.toMatch(SPOT_COORDINATES);
    }));

  it("accepting proposals that changed since the page showed them is refused as stale, nothing written (ruling M7-B-R2)", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const shown = await shownDigest(tx, placeId);
      // another digest: the proposals the admin saw are not the ones the server computes now
      const r = await acceptProposalsAction({ placeId, subdivisionKey: SUBDIVISION, digest: "0123456789abcdef" });
      expect(r).toEqual({ ok: false, code: "stale" });
      expectCodesAndCounts(r);
      expect(await resultsOf(tx, placeId)).toEqual([]);
      // the berth state changes after the page was rendered: the shown digest is stale too
      await insertBerthState(tx, placeId, { "services.water": true });
      expect(await acceptProposalsAction({ placeId, subdivisionKey: SUBDIVISION, digest: shown })).toEqual({ ok: false, code: "stale" });
      expect(await resultsOf(tx, placeId)).toEqual([]);
      // a missing digest is invalid input
      // @ts-expect-error the digest is required
      await expect(acceptProposalsAction({ placeId, subdivisionKey: SUBDIVISION })).rejects.toThrow();
    }));

  it("accepting never overwrites an outcome set by hand; the result counts what it kept (ruling M7-B-R2)", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const valueHash = await currentHash(tx, placeId, "services.water");
      // the admin decided by hand that water matches; the proposal says deviation
      expect(await recordComparisonAction({ placeId, subdivisionKey: SUBDIVISION, attribute: "services.water", result: "match", valueHash })).toEqual({
        ok: true,
        written: 1,
        tasks: 0,
      });
      const r = await accept(tx, placeId);
      expect(r).toEqual({ ok: true, written: 15, tasks: 0, skippedManual: 1 });
      const water = (await resultsOf(tx, placeId)).filter((x) => x.attribute === "services.water");
      expect(water.map((x) => [x.result, x.method])).toEqual([["match", "manual"]]);
      expect(await tasksOf(tx, placeId)).toEqual([]);
    }));

  it("loads the comparison subject inside the write transaction (ruling M7-B-R2)", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const digest = await shownDigest(tx, placeId);
      subjectLoads.length = 0;
      await acceptProposalsAction({ placeId, subdivisionKey: SUBDIVISION, digest });
      expect(subjectLoads).toHaveLength(1);
      const valueHash = await currentHash(tx, placeId, "depth"); // the test's own load, on `tx`
      await recordComparisonAction({ placeId, subdivisionKey: SUBDIVISION, attribute: "depth", result: "deviation", valueHash });
      expect(subjectLoads).toHaveLength(3);
      expect(subjectLoads[1]).toBe(tx);
      // each action loaded on a transaction of its own (a savepoint of the test transaction), never on `tx` itself
      expect(subjectLoads[0]).not.toBe(tx);
      expect(subjectLoads[2]).not.toBe(tx);
    }));

  it("recordComparisonAction writes a manual result for the current value", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const valueHash = await currentHash(tx, placeId, "depth");
      const r = await recordComparisonAction({ placeId, subdivisionKey: SUBDIVISION, attribute: "depth", result: "deviation", valueHash });
      expect(r).toEqual({ ok: true, written: 1, tasks: 1 });
      expectCodesAndCounts(r);
      const rows = await resultsOf(tx, placeId);
      expect(rows).toMatchObject([{ attribute: "depth", result: "deviation", method: "manual", checkedBy: ADMIN, valueHash, profileVersion: null }]);
      expect(await tasksOf(tx, placeId)).toHaveLength(1);
    }));

  it("an outcome for an evaluation value never opens or closes a deviation task of the regular place (ruling M7-E-R2)", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const regularHash = await currentHash(tx, placeId, "services.water");
      await recordComparisonAction({ placeId, subdivisionKey: SUBDIVISION, attribute: "services.water", result: "deviation", valueHash: regularHash });
      const [regular] = await tasksOf(tx, placeId);
      expect(regular).toMatchObject({ status: "open", subjectId: `${placeId}:services.water:${regularHash}`, context: { evaluationRunId: null } });

      // an evaluation whose profile holds another water value
      const { id: evaluationRunId } = await createRun(tx, {
        kind: "reprocess",
        scope: { type: "system", id: "consolidation" },
        stages: [CONSOLIDATION_GEO_STAGE],
        params: { comparisonSetSubdivision: SUBDIVISION, evaluation: true, rulesVersion: "v1", candidate: { rulesVersion: "v1" } },
        triggeredBy: "test",
      });
      await tx.update(runs).set({ status: "finished" }).where(eq(runs.id, evaluationRunId));
      const [place] = await tx.select({ geoObjectId: places.geoObjectId }).from(places).where(eq(places.id, placeId));
      await tx.insert(evaluationProfiles).values({ runId: evaluationRunId, geoObjectId: place!.geoObjectId, rulesVersion: "v1", factSchemaVersion: "v2", attributes: { "services.water": true }, provenance: {}, contentHash: "e" });
      const subject = (await loadComparisonSubjects(tx, SUBDIVISION, { evaluationRunId })).find((s) => s.placeId === placeId)!;
      const evaluationHash = comparisonValues(subject, getConfig().quality.navily)["services.water"].hash;
      expect(evaluationHash).not.toBe(regularHash);

      const deviation = { placeId, subdivisionKey: SUBDIVISION, attribute: "services.water" as const, valueHash: evaluationHash, evaluationRunId };
      await recordComparisonAction({ ...deviation, result: "deviation" });
      const regularTasks = (await tasksOf(tx, placeId)).filter((t) => (t.context as { evaluationRunId: string | null }).evaluationRunId === null);
      // the regular place keeps exactly its own task, unchanged
      expect(regularTasks).toEqual([regular]);
      for (const t of await tasksOf(tx, placeId)) {
        if (t.id !== regular!.id) expect(t).toMatchObject({ subjectId: `${placeId}:services.water:${evaluationHash}`, context: { evaluationRunId } });
      }

      // a match for the evaluation value settles that value only: the regular deviation stays open
      await recordComparisonAction({ ...deviation, result: "match" });
      const after = await tasksOf(tx, placeId);
      expect(after.find((t) => t.id === regular!.id)).toMatchObject({ status: "open" });
      expect(after.filter((t) => t.id !== regular!.id).every((t) => t.status === "dismissed")).toBe(true);
    }));

  it("a stale value hash gives the code stale and writes nothing", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const r = await recordComparisonAction({ placeId, subdivisionKey: SUBDIVISION, attribute: "services.water", result: "match", valueHash: "0123456789abcdef" });
      expect(r).toEqual({ ok: false, code: "stale" });
      expectCodesAndCounts(r);
      expect(await resultsOf(tx, placeId)).toEqual([]);
    }));

  it("refuses invalid input, an unknown subdivision, a place outside the set and a non-admin", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const valueHash = await currentHash(tx, placeId, "services.water");
      const ok = { placeId, subdivisionKey: SUBDIVISION, attribute: "services.water" as const, result: "match" as const, valueHash };
      await expect(recordComparisonAction({ ...ok, subdivisionKey: "atlantis" })).rejects.toThrow();
      // @ts-expect-error a review outcome is never recorded from the page
      await expect(recordComparisonAction({ ...ok, result: "deviation_confirmed_own" })).rejects.toThrow();
      await expect(recordComparisonAction({ ...ok, placeId: "0190a1b2-0000-7000-8000-000000000001" })).rejects.toThrow(/comparison set/);
      await expect(acceptProposalsAction({ placeId: "nope", subdivisionKey: SUBDIVISION, digest: "0123456789abcdef" })).rejects.toThrow();
      requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
      await expect(recordComparisonAction(ok)).rejects.toThrow("NEXT_REDIRECT");
      await expect(acceptProposalsAction({ placeId, subdivisionKey: SUBDIVISION, digest: "0123456789abcdef" })).rejects.toThrow("NEXT_REDIRECT");
      expect(await resultsOf(tx, placeId)).toEqual([]);
    }));

  it("without a navily file or with an unreadable one accepting gives a code, never the path or the content", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const digest = await shownDigest(tx, placeId);
      navilyPath = null;
      const missing = await acceptProposalsAction({ placeId, subdivisionKey: SUBDIVISION, digest });
      expect(missing).toEqual({ ok: false, code: "navily_missing" });
      expectCodesAndCounts(missing);
      navilyPath = path.join(dir, "broken.json");
      await writeFile(navilyPath, '[{"lat": "NAVILY-ONLY-NAME"}]');
      const unreadable = await acceptProposalsAction({ placeId, subdivisionKey: SUBDIVISION, digest });
      expect(unreadable).toEqual({ ok: false, code: "navily_unreadable" });
      expectCodesAndCounts(unreadable);
      expect(JSON.stringify(unreadable)).not.toContain("broken.json");
      expect(await resultsOf(tx, placeId)).toEqual([]);
    }));
});
