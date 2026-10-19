import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { comparisonSet, externalCalls, geoObjects, places, runs, runStages } from "@/lib/db/schema";
import { SECTORS, type Sector } from "@/lib/domain/facts/schema-types";
import { newId } from "@/lib/domain/ids";
import {
  comparePlace,
  datasetImportCosts,
  geometryRunStats,
  loadNavilySpots,
  ownValuesForComparisonSet,
  renderReport,
  type NavilySpot,
  type OwnPlaceValues,
} from "@/lib/domain/quality/navily-sample";
import { computePlaceGeometry } from "@/lib/pipeline/geometry";
import { withRollback } from "@/test/db";
import { buildBayScene, insertScenePlace } from "@/test/geometry/scene";

const OPTS = { radiusM: 500, protectedThreshold: 0.5 };
const AT = { lon: 21.0, lat: 35.24 };

// Synthetic spots shaped like the comparison file; names, ids and urls are made up.
const SYNTHETIC = [
  {
    id: 987654321,
    kind: "anchorage",
    type: "bay",
    name: "NAVILY-ONLY-NAME",
    lat: AT.lat,
    lon: AT.lon,
    prot: ["n", "ne", "nw"],
    seabeds: ["algae", "sand"],
    rating: 4.5,
    url: "https://www.navily.com/x",
    maxDraft: 3,
    maxLength: 20,
    water: false,
    shop: true,
  },
  {
    id: 123456789,
    kind: "anchorage",
    type: "bay",
    name: "NAVILY-OTHER",
    lat: AT.lat + 0.1,
    lon: AT.lon,
    prot: ["s"],
    seabeds: null,
    rating: 3,
    url: "https://www.navily.com/y",
    maxDraft: null,
    maxLength: null,
    water: null,
    shop: null,
  },
];

let dir: string;
let file: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "navily-sample-"));
  file = path.join(dir, "spots.json");
  await writeFile(file, JSON.stringify(SYNTHETIC));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function shelter(values: Partial<Record<Sector, number>>, rest = 0.1): Record<Sector, number> {
  return Object.fromEntries(SECTORS.map((s) => [s, values[s] ?? rest])) as Record<Sector, number>;
}

function own(over: Partial<OwnPlaceValues> = {}): OwnPlaceValues {
  return {
    placeId: "p-1",
    publicId: "sp_TEST",
    name: "Testbucht",
    position: AT,
    shelter: shelter({ N: 0.9, NE: 0.8, NW: 0.7 }),
    seabed: ["weed"],
    depthGap: null,
    hasDepth: true,
    ...over,
  };
}

/** A point `m` metres north of `AT`. */
const north = (m: number) => ({ lon: AT.lon, lat: AT.lat + m / 111_320 });

describe("loadNavilySpots", () => {
  it("keeps only position, protection and seabeds", async () => {
    const spots = await loadNavilySpots(file);
    expect(spots).toHaveLength(2);
    expect(spots[0]).toEqual({ lat: AT.lat, lon: AT.lon, prot: ["n", "ne", "nw"], seabeds: ["algae", "sand"] });
    expect(Object.keys(spots[1]!).sort()).toEqual(["lat", "lon", "prot", "seabeds"]);
  });
});

describe("comparePlace", () => {
  it("prot [n, ne, nw] vs own N .9, NE .8, NW .7, rest .1 → 8/8 'stimmt'", async () => {
    const spots = await loadNavilySpots(file);
    const v = comparePlace(own(), spots, OPTS);
    expect(v.matched).toBe(true);
    expect(v.sectorsAgree).toBe(8);
    expect(Object.values(v.sectorResults!).every((r) => r === "match")).toBe(true);
    expect(v.verdict).toBe("stimmt");
    expect(v.depth).toBe("value");
  });

  it("4–5 agreeing sectors → 'teilweise', ≤ 3 → 'weicht ab'", () => {
    const spot: NavilySpot = { ...AT, prot: ["n", "ne", "nw"], seabeds: null };
    // Own protection on N, NE, NW, E, SE, S: 3 deviations → 5/8.
    const five = comparePlace(own({ shelter: shelter({ N: 1, NE: 1, NW: 1, E: 1, SE: 1, S: 1 }) }), [spot], OPTS);
    expect(five.sectorsAgree).toBe(5);
    expect(five.sectorResults!.E).toBe("deviation");
    expect(five.verdict).toBe("teilweise");
    // Inverse of Navily everywhere: 0/8.
    const none = comparePlace(own({ shelter: shelter({ N: 0, NE: 0, NW: 0 }, 0.9) }), [spot], OPTS);
    expect(none.sectorsAgree).toBe(0);
    expect(none.verdict).toBe("weicht ab");
  });

  it("the threshold decides: a sector at exactly 0.5 counts as protected", () => {
    const spot: NavilySpot = { ...AT, prot: ["n"], seabeds: null };
    const v = comparePlace(own({ shelter: shelter({ N: 0.5 }, 0.49) }), [spot], OPTS);
    expect(v.sectorsAgree).toBe(8);
  });

  it("nearest spot 800 m away → 'nicht bei Navily'", () => {
    const spot: NavilySpot = { ...north(800), prot: ["n"], seabeds: ["sand"] };
    const v = comparePlace(own(), [spot], OPTS);
    expect(v.matched).toBe(false);
    expect(v.sectorsAgree).toBeNull();
    expect(v.sectorResults).toBeNull();
    expect(v.seabed).toBe("not_at_navily");
    expect(v.verdict).toBe("nicht bei Navily");
  });

  it("matches the nearest spot within the radius", () => {
    const far: NavilySpot = { ...north(400), prot: [], seabeds: null };
    const near: NavilySpot = { ...north(100), prot: ["n", "ne", "nw"], seabeds: null };
    expect(comparePlace(own(), [far, near], OPTS).sectorsAgree).toBe(8);
  });

  it("algae matches own weed", () => {
    const spot: NavilySpot = { ...AT, prot: ["n"], seabeds: ["algae"] };
    expect(comparePlace(own({ seabed: ["weed"] }), [spot], OPTS).seabed).toBe("match");
    expect(comparePlace(own({ seabed: ["sand", "rock"] }), [spot], OPTS).seabed).toBe("deviation");
    expect(comparePlace(own({ seabed: null }), [spot], OPTS).seabed).toBe("no_own_value");
    expect(comparePlace(own(), [{ ...spot, seabeds: null }], OPTS).seabed).toBe("not_at_navily");
  });

  it("a place without shelter facts → 'ohne Geometrie'", () => {
    const spot: NavilySpot = { ...AT, prot: ["n"], seabeds: null };
    const v = comparePlace(own({ shelter: null, hasDepth: false, depthGap: "no_water" }), [spot], OPTS);
    expect(v.verdict).toBe("ohne Geometrie");
    expect(v.sectorsAgree).toBeNull();
    expect(v.depth).toBe("no_water");
  });

  it("reports depth as coverage only", () => {
    const spot: NavilySpot = { ...AT, prot: ["n", "ne", "nw"], seabeds: null };
    const v = comparePlace(own({ hasDepth: false, depthGap: "no_bathymetry" }), [spot], OPTS);
    expect(v.depth).toBe("no_bathymetry");
    expect(v.verdict).toBe("stimmt");
  });
});

describe("renderReport", () => {
  it("the report contains no Navily values", async () => {
    const spots = await loadNavilySpots(file);
    const verdicts = [
      comparePlace(own(), spots, OPTS),
      comparePlace(own({ placeId: "p-2", publicId: null, name: "Fernbucht", position: north(5000) }), spots, OPTS),
      comparePlace(own({ placeId: "p-3", name: "Leerbucht", shelter: null, depthGap: "no_water", hasDepth: false }), spots, OPTS),
    ];
    const md = renderReport({
      areaKey: "saronic",
      generatedAt: new Date("2026-10-19T08:00:00Z"),
      verdicts,
      runtime: { runId: "run-1", places: 120, durationS: 600, perPlaceS: 5 },
      costs: { calls: 7, costEur: 0, byService: { emodnet: 5, overpass: 2 } },
    });
    for (const s of ["NAVILY-ONLY-NAME", "987654321", "navily.com", '"prot"', "algae"]) expect(md).not.toContain(s);
    expect(md).toContain("Navily-Werte wurden nur zur Laufzeit gelesen und nicht gespeichert (Grundprinzip 9).");
    expect(md).toContain("Testbucht");
    expect(md).toContain("sp_TEST");
    expect(md).toContain("8/8");
    expect(md).toContain("nicht bei Navily");
    expect(md).toContain("ohne Geometrie");
    expect(md).toContain("Laufzeit und Kosten");
    expect(md).toMatch(/Verglichene Orte \(mit Geometrie\) \| 2/);
    expect(md).toMatch(/Bei Navily gefunden \| 1/);
    expect(md).toMatch(/Sektor-Übereinstimmung gesamt \| 100 %/);
    expect(md).toMatch(/Tiefen-Deckung \| 100 %/);
  });

  it("says so when no run or no costs exist", () => {
    const md = renderReport({
      areaKey: "saronic",
      generatedAt: new Date("2026-10-19T08:00:00Z"),
      verdicts: [],
      runtime: null,
      costs: { calls: 0, costEur: 0, byService: {} },
    });
    expect(md).toContain("Kein beendeter Geometrie-Lauf");
    expect(md).toMatch(/Verglichene Orte \(mit Geometrie\) \| 0/);
  });
});

describe("ownValuesForComparisonSet", () => {
  it("ownValuesForComparisonSet reads facts of the latest computations", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      const bare = await insertScenePlace(tx, -5000, -3000, { status: "confirmed" });
      const outsideSet = await insertScenePlace(tx, 5000, -3000, { status: "confirmed" });
      const rejected = await insertScenePlace(tx, -6000, -3000, { status: "rejected" });
      await tx.update(places).set({ status: "confirmed" }).where(eq(places.id, scene.placeId));
      await computePlaceGeometry(tx, scene.placeId, { today: "2026-10-19" });
      await computePlaceGeometry(tx, outsideSet.placeId, { today: "2026-10-19" });

      const areaKey = `test-${newId()}`;
      const [area] = await tx
        .insert(geoObjects)
        .values({ type: "area", origin: "manual", configKey: areaKey, geom: sql`${geomFromGeoJson({ type: "Point", coordinates: [21, 35.24] })}` })
        .returning({ id: geoObjects.id });
      await tx.insert(comparisonSet).values([
        { placeId: scene.placeId, areaId: area!.id, addedBy: "test" },
        { placeId: bare.placeId, areaId: area!.id, addedBy: "test" },
        { placeId: rejected.placeId, areaId: area!.id, addedBy: "test" },
      ]);

      const values = await ownValuesForComparisonSet(tx, areaKey);
      expect(values.map((v) => v.placeId).sort()).toEqual([scene.placeId, bare.placeId].sort());

      const bay = values.find((v) => v.placeId === scene.placeId)!;
      expect(bay.position.lon).toBeCloseTo(scene.position.lon, 6);
      expect(bay.position.lat).toBeCloseTo(scene.position.lat, 6);
      expect(Object.keys(bay.shelter!).sort()).toEqual([...SECTORS].sort());
      expect(bay.shelter!.N).toBeGreaterThanOrEqual(0.93);
      expect(bay.shelter!.S).toBeLessThan(0.1);
      expect(bay.seabed!.sort()).toEqual(["mud", "sand"]);
      expect(bay.hasDepth).toBe(true);
      expect(bay.depthGap).toBeNull();

      const empty = values.find((v) => v.placeId === bare.placeId)!;
      expect(empty.shelter).toBeNull();
      expect(empty.seabed).toBeNull();
      expect(empty.hasDepth).toBe(false);
      expect(empty.depthGap).toBeNull();
    }));

  it("returns an empty list for an unknown area", () =>
    withRollback(async (tx) => {
      expect(await ownValuesForComparisonSet(tx, `test-${newId()}`)).toEqual([]);
    }));
});

describe("run statistics", () => {
  it("geometryRunStats takes the newest finished geometry run of the area", () =>
    withRollback(async (tx) => {
      const areaKey = `test-${newId()}`;
      const insertRun = async (status: "finished" | "running", start: string, end: string | null, total: number, scopeId = areaKey) => {
        const [r] = await tx
          .insert(runs)
          .values({
            kind: "stage",
            scopeType: "area",
            scopeId,
            stages: ["geometry.place"],
            triggeredBy: "test",
            status,
            startedAt: new Date(start),
            finishedAt: end ? new Date(end) : null,
          })
          .returning({ id: runs.id });
        await tx.insert(runStages).values({ runId: r!.id, stage: "geometry.place", ordinal: 0, total, done: total });
        return r!.id;
      };
      expect(await geometryRunStats(tx, areaKey)).toBeNull();
      await insertRun("finished", "2026-10-01T10:00:00Z", "2026-10-01T10:10:00Z", 50);
      const newest = await insertRun("finished", "2026-10-02T10:00:00Z", "2026-10-02T10:05:00Z", 100);
      await insertRun("running", "2026-10-03T10:00:00Z", null, 100);
      await insertRun("finished", "2026-10-04T10:00:00Z", "2026-10-04T10:01:00Z", 10, `other-${newId()}`);
      expect(await geometryRunStats(tx, areaKey)).toEqual({ runId: newest, places: 100, durationS: 300, perPlaceS: 3 });
    }));

  it("datasetImportCosts sums the external calls of the newest dataset import run", () =>
    withRollback(async (tx) => {
      const areaKey = `test-${newId()}`;
      expect(await datasetImportCosts(tx, areaKey)).toEqual({ calls: 0, costEur: 0, byService: {} });
      const insertRun = async (createdAt: string) => {
        const [r] = await tx
          .insert(runs)
          .values({ kind: "stage", scopeType: "area", scopeId: areaKey, stages: ["datasets.import"], triggeredBy: "test", createdAt: new Date(createdAt) })
          .returning({ id: runs.id });
        return r!.id;
      };
      const older = await insertRun("2026-10-01T10:00:00Z");
      const newest = await insertRun("2026-10-02T10:00:00Z");
      const call = (runId: string, service: string, costEur: string) => ({
        service,
        operation: "test",
        units: "1",
        unit: "request",
        costEur,
        runId,
        stage: "datasets.import",
      });
      await tx.insert(externalCalls).values([
        call(older, "emodnet", "9"),
        call(newest, "emodnet", "0"),
        call(newest, "emodnet", "0"),
        call(newest, "overpass", "0.5"),
      ]);
      expect(await datasetImportCosts(tx, areaKey)).toEqual({ calls: 3, costEur: 0.5, byService: { emodnet: 2, overpass: 1 } });
    }));
});
