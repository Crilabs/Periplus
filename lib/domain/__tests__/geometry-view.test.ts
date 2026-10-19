import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { placeGeometry } from "@/lib/domain/geometry-view";
import { newId } from "@/lib/domain/ids";
import { computePlaceGeometry } from "@/lib/pipeline/geometry";
import { withRollback } from "@/test/db";
import { buildBayScene, insertScenePlace } from "@/test/geometry/scene";

const TODAY = "2026-10-19";

async function distanceM(tx: Db, a: { lon: number; lat: number }, b: { lon: number; lat: number }): Promise<number> {
  const { rows } = await tx.execute<{ d: number }>(sql`
    select ST_Distance(ST_SetSRID(ST_MakePoint(${a.lon}::float8, ${a.lat}::float8), 4326)::geography,
                       ST_SetSRID(ST_MakePoint(${b.lon}::float8, ${b.lat}::float8), 4326)::geography) as d`);
  return Number(rows[0]!.d);
}

describe("placeGeometry", () => {
  it("placeGeometry returns 72 rays, 8 sectors, depths and gaps for a computed place", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      const outside = await insertScenePlace(tx, 5000, -3000);
      await computePlaceGeometry(tx, scene.placeId, { today: TODAY });
      await computePlaceGeometry(tx, outside.placeId, { today: TODAY });

      const view = (await placeGeometry(tx, scene.placeId))!;
      expect(view).not.toBeNull();
      expect(view.computedAt).toBeInstanceOf(Date);
      expect(view.rulesVersion).toBe("geometry-1");
      expect(view.originSource).toBe("computed_anchor");
      expect(view.origin).not.toBeNull();

      expect(Object.keys(view.sectors!).sort()).toEqual([...SECTORS].sort());
      expect(view.sectors!.N.shelter).toBeGreaterThanOrEqual(0.93);
      expect(view.sectors!.S.shelter).toBeLessThan(0.1);
      expect(view.sectors!.S.fetchM).toBe(50000);
      expect(view.swell).not.toBeNull();
      expect(view.opening!.bearingDeg).toBe(180);

      expect(view.rays).toHaveLength(72);
      expect(view.rays.map((r) => r.bearingDeg)).toEqual(Array.from({ length: 72 }, (_, i) => i * 5));
      const north = view.rays[0]!;
      const south = view.rays[36]!;
      expect(north.fetchM).toBeLessThan(1000);
      expect(north.shelter).toBeGreaterThan(0.5);
      expect(south.fetchM).toBe(50000);
      expect(south.shelter).toBe(0);
      expect(await distanceM(tx, view.origin!, north.end)).toBeCloseTo(north.fetchM, -1);
      expect(await distanceM(tx, view.origin!, south.end)).toBeCloseTo(3000, -1);
      expect(south.end.lat).toBeLessThan(view.origin!.lat);

      expect(view.depth.approach).not.toBeNull();
      expect(Object.keys(view.depth.approach!)).toEqual(["at50m", "at100m", "at200m"]);
      expect(view.depth.min).not.toBeNull();
      expect(view.depth.max).toBeGreaterThan(view.depth.min!);
      expect(view.depth.anchoringMin).toBeGreaterThanOrEqual(3);
      expect(view.depth.anchoringMax).toBeLessThanOrEqual(12);
      expect(view.depth.confidence).not.toBeNull();
      expect(view.depthSamples.map((d) => d.distanceM)).toEqual([50, 100, 200]);
      expect(view.depthSamples[0]!.depthM).toBe(view.depth.approach!.at50m);
      expect(await distanceM(tx, view.origin!, view.depthSamples[2]!.position)).toBeCloseTo(200, -1);

      expect(view.seabed!.map((s) => s.type).sort()).toEqual(["mud", "sand"]);
      expect(view.water?.type).toMatch(/Polygon/);
      expect(view.anchorArea!.areaM2).toBeGreaterThan(0);
      expect(view.anchorArea!.geometry?.type).toMatch(/Polygon/);
      expect(view.anchorPosition).toMatchObject({ origin: "computed" });
      expect(view.anchorPosition!.confidence).toBeCloseTo(0.3, 6);
      expect(view.restriction).toEqual([]);
      expect(view.gaps).toEqual([]);
      expect(view.computations.map((c) => c.kind)).toEqual([
        "anchor_area",
        "fetch",
        "shelter",
        "depth",
        "seabed",
        "restriction",
        "quietness",
      ]);
      expect(view.computations.every((c) => c.rulesVersion === "geometry-1")).toBe(true);

      // Outside the raster: gaps from the anchor area and depth computations.
      const gapView = (await placeGeometry(tx, outside.placeId))!;
      expect(gapView.rays).toHaveLength(72);
      expect(gapView.anchorArea).toBeNull();
      expect(gapView.gaps).toContainEqual({ attribute: "anchor_position", reason: "no_anchor_area" });
      expect(gapView.gaps).toContainEqual({ attribute: "depth.min", reason: "no_bathymetry" });
    }));

  it("placeGeometry for a place without computations has null values and empty lists", () =>
    withRollback(async (tx) => {
      const place = await insertScenePlace(tx, 0, 100);
      expect(await placeGeometry(tx, place.placeId)).toEqual({
        computedAt: null,
        rulesVersion: null,
        origin: null,
        originSource: null,
        sectors: null,
        swell: null,
        opening: null,
        rays: [],
        depth: { approach: null, min: null, max: null, anchoringMin: null, anchoringMax: null, confidence: null },
        depthSamples: [],
        seabed: null,
        water: null,
        anchorArea: null,
        anchorPosition: null,
        restriction: [],
        gaps: [],
        computations: [],
      });
    }));

  it("placeGeometry for an unknown place is null", async () => {
    await withRollback(async (tx) => {
      expect(await placeGeometry(tx, newId())).toBeNull();
    });
  });
});
