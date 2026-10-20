import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { comparisonResults, comparisonSet, geoObjects, places, reviewTasks } from "@/lib/db/schema";
import { StaleComparison } from "@/lib/domain/quality/comparison-results";
import { comparisonValues, loadComparisonSubjects } from "@/lib/domain/quality/comparison-values";
import { getConfig } from "@/lib/config";
import { insertProfile, provenanceEntry } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";
import { insertNamedObject } from "@/test/text";

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

import { acceptProposalsAction, recordComparisonAction } from "../quality/compare/actions";

const FIXTURE = path.join(process.cwd(), "test/fixtures/navily/sample.json");
const ADMIN = "admin@example.invalid";
const NAVILY_MARKERS = /NAVILY-ONLY-NAME|NAVILY-PORT|987654321|123456789|navily\.com/;

beforeEach(() => {
  vi.resetAllMocks();
  currentDb = db;
  navilyPath = FIXTURE;
  requireAdmin.mockResolvedValue({ email: ADMIN });
});

/**
 * A confirmed anchorage at 21.0° E / 35.2° N (on the fixture's first spot, outside the pilot box) in the saronic
 * comparison set, rolled back. Its values agree with the spot except `services.water` (own false, Navily true).
 */
async function setUp(tx: Db) {
  currentDb = tx;
  let [area] = await tx
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(sql`${geoObjects.type} = 'area' and ${geoObjects.configKey} = 'saronic' and ${geoObjects.validTo} is null`);
  area ??= (
    await tx
      .insert(geoObjects)
      .values({ type: "area", origin: "manual", configKey: "saronic", geom: geomFromGeoJson({ type: "Point", coordinates: [24.61, 32.83] }) })
      .returning({ id: geoObjects.id })
  )[0]!;
  const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.0, lat: 35.2 });
  const [place] = await tx
    .insert(places)
    .values({ geoObjectId: objectId, kind: "anchorage", status: "confirmed", position: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] }) })
    .returning({ id: places.id });
  await tx.insert(comparisonSet).values({ placeId: place!.id, areaId: area.id, addedBy: "test" });
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
  await insertProfile(tx, objectId, attributes, { "shelter.N": provenanceEntry("computed") }, { version: 2 });
  return { placeId: place!.id };
}

const resultsOf = (tx: Db, placeId: string) => tx.select().from(comparisonResults).where(eq(comparisonResults.placeId, placeId));
const tasksOf = (tx: Db, placeId: string) =>
  tx
    .select()
    .from(reviewTasks)
    .where(and(eq(reviewTasks.kind, "comparison_deviation"), sql`${reviewTasks.subjectId} like ${`${placeId}:%`}`));

async function currentHash(tx: Db, placeId: string, attribute: "services.water" | "depth") {
  const subject = (await loadComparisonSubjects(tx, "saronic")).find((s) => s.placeId === placeId)!;
  return comparisonValues(subject, getConfig().quality.navily)[attribute].hash;
}

describe("/quality/compare actions", () => {
  it("acceptProposalsAction writes one result per attribute with method proposal_confirmed", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const r = await acceptProposalsAction({ placeId, areaKey: "saronic" });
      expect(r.written).toBe(16);
      const rows = await resultsOf(tx, placeId);
      expect(rows).toHaveLength(16);
      expect(rows.every((x) => x.method === "proposal_confirmed" && x.checkedBy === ADMIN)).toBe(true);
      expect(rows.every((x) => x.profileVersion === 2 && x.evaluationRunId === null)).toBe(true);
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
      await acceptProposalsAction({ placeId, areaKey: "saronic" });
      expect(await acceptProposalsAction({ placeId, areaKey: "saronic" })).toEqual({ written: 0, tasks: 0 });
      expect(await resultsOf(tx, placeId)).toHaveLength(16);
    }));

  it("a deviation proposal opens one review task", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const r = await acceptProposalsAction({ placeId, areaKey: "saronic" });
      expect(r.tasks).toBe(1);
      const tasks = await tasksOf(tx, placeId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.context).toMatchObject({ attribute: "services.water", ownDisplay: "nein", profileVersion: 2 });
      // Grundprinzip 9: no navily name, id or url in any stored row
      expect(JSON.stringify([await resultsOf(tx, placeId), tasks])).not.toMatch(NAVILY_MARKERS);
    }));

  it("recordComparisonAction writes a manual result for the current value", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const valueHash = await currentHash(tx, placeId, "depth");
      await recordComparisonAction({ placeId, areaKey: "saronic", attribute: "depth", result: "deviation", valueHash });
      const rows = await resultsOf(tx, placeId);
      expect(rows).toMatchObject([{ attribute: "depth", result: "deviation", method: "manual", checkedBy: ADMIN, valueHash, profileVersion: 2 }]);
      expect(await tasksOf(tx, placeId)).toHaveLength(1);
    }));

  it("a stale value hash is rejected and writes nothing", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      await expect(
        recordComparisonAction({ placeId, areaKey: "saronic", attribute: "services.water", result: "match", valueHash: "0123456789abcdef" }),
      ).rejects.toBeInstanceOf(StaleComparison);
      expect(await resultsOf(tx, placeId)).toEqual([]);
    }));

  it("refuses invalid input, an unknown area, a place outside the set and a non-admin", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      const valueHash = await currentHash(tx, placeId, "services.water");
      const ok = { placeId, areaKey: "saronic", attribute: "services.water" as const, result: "match" as const, valueHash };
      await expect(recordComparisonAction({ ...ok, areaKey: "atlantis" })).rejects.toThrow();
      // @ts-expect-error a review outcome is never recorded from the page
      await expect(recordComparisonAction({ ...ok, result: "deviation_confirmed_own" })).rejects.toThrow();
      await expect(recordComparisonAction({ ...ok, placeId: "0190a1b2-0000-7000-8000-000000000001" })).rejects.toThrow(/comparison set/);
      await expect(acceptProposalsAction({ placeId: "nope", areaKey: "saronic" })).rejects.toThrow();
      requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
      await expect(recordComparisonAction(ok)).rejects.toThrow("NEXT_REDIRECT");
      await expect(acceptProposalsAction({ placeId, areaKey: "saronic" })).rejects.toThrow("NEXT_REDIRECT");
      expect(await resultsOf(tx, placeId)).toEqual([]);
    }));

  it("accepting without a navily file fails with a clear message", () =>
    withRollback(async (tx) => {
      const { placeId } = await setUp(tx);
      navilyPath = null;
      await expect(acceptProposalsAction({ placeId, areaKey: "saronic" })).rejects.toThrow("Navily-Datei nicht geladen");
      expect(await resultsOf(tx, placeId)).toEqual([]);
    }));
});
