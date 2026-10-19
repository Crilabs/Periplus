import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { withRollback } from "@/test/db";
import { circle, difference, distanceToLand, insertLand, lonLatOf, rect, utm, utmOf } from "@/test/geometry/synthetic";
import { computeFetch } from "../rays";
import { opening, shelterFromFetch, swellProtection } from "../shelter";
import { resolveOrigin, waterArea } from "../water";

const cfg = loadConfig("config").geometry;

/** Half-circle bay open to the south: land north of y = 0 minus a 500 m circle around (0, 0). */
async function bayScene(tx: Db) {
  await insertLand(tx, [await difference(tx, rect(-20000, 0, 20000, 20000), await circle(tx, 0, 0, 500))]);
}

/** Expected sector shelter N, NE, E, SE, S, SW, W, NW (± 0.02), opening and swell from the given origin. */
async function expectScene(
  tx: Db,
  x: number,
  y: number,
  expected: { sectors: number[]; bearingDeg: number | null; widthDeg: number; swell: number },
) {
  const { rays, srid } = await computeFetch(tx, await lonLatOf(tx, x, y), cfg);
  expect(srid).toBe(32634);
  expect(rays).toHaveLength(72);
  const sectors = shelterFromFetch(rays, cfg);
  SECTORS.forEach((s, i) => expect(Math.abs(sectors[s] - expected.sectors[i]!), s).toBeLessThanOrEqual(0.02));
  expect(opening(rays, cfg)).toEqual({ bearingDeg: expected.bearingDeg, widthDeg: expected.widthDeg });
  expect(Math.abs(swellProtection(rays, sectors, cfg) - expected.swell)).toBeLessThanOrEqual(0.02);
  return rays;
}

const near = (value: number, expected: number, tolerance: number) =>
  expect(Math.abs(value - expected), `${value} vs ${expected}`).toBeLessThanOrEqual(tolerance);

describe("computeFetch", () => {
  it("half-circle bay open to the south", () =>
    withRollback(async (tx) => {
      await bayScene(tx);
      const rays = await expectScene(tx, 0, 100, {
        sectors: [0.93, 0.913, 0.483, 0, 0, 0, 0.483, 0.913],
        bearingDeg: 180,
        widthDeg: 155,
        swell: 0,
      });
      near(rays[0]!, 400, 2);
      near(rays[18]!, 490, 2);
      near(rays[20]!, 508, 3);
      expect(rays[21]).toBe(50000);
      expect(rays[36]).toBe(50000);
      expect(rays.every(Number.isInteger)).toBe(true);
    }));

  it("channel", () =>
    withRollback(async (tx) => {
      await insertLand(tx, [rect(-20000, -30000, -400, 30000), rect(400, -30000, 20000, 30000)]);
      const rays = await expectScene(tx, 0, 0, {
        sectors: [0.335, 0.803, 0.923, 0.803, 0.335, 0.803, 0.923, 0.803],
        bearingDeg: null,
        widthDeg: 50,
        swell: 0.335,
      });
      expect(rays[0]).toBe(50000);
      near(rays[1]!, 4589, 10);
      near(rays[18]!, 400, 2);
    }));

  it("island in the sea", () =>
    withRollback(async (tx) => {
      await insertLand(tx, [await circle(tx, 0, 2200, 2000)]);
      const rays = await expectScene(tx, 0, 0, {
        sectors: [1, 0.898, 0, 0, 0, 0, 0, 0.898],
        bearingDeg: 180,
        widthDeg: 225,
        swell: 0,
      });
      near(rays[0]!, 200, 2);
      near(rays[13]!, 773, 5);
      expect(rays[14]).toBe(50000);
    }));

  it("landVersions lists the dataset versions within reach", () =>
    withRollback(async (tx) => {
      await insertLand(tx, [await circle(tx, 0, 2200, 2000)]);
      await insertLand(tx, [await circle(tx, 0, -3000, 500)], "synthetic-0");
      await insertLand(tx, [await circle(tx, 0, 80000, 500)], "synthetic-far");
      const { landVersions } = await computeFetch(tx, await lonLatOf(tx, 0, 0), cfg);
      expect(landVersions).toEqual(["synthetic-0", "synthetic-1"]);
    }));

  it("without land every ray has the full length", () =>
    withRollback(async (tx) => {
      const { rays, landVersions } = await computeFetch(tx, await lonLatOf(tx, 0, 0), cfg);
      expect(rays).toEqual(Array(72).fill(50000));
      expect(landVersions).toEqual([]);
    }));
});

describe("resolveOrigin", () => {
  it("origin on land is moved into water", () =>
    withRollback(async (tx) => {
      await bayScene(tx);
      const position = await lonLatOf(tx, 0, 1000);
      const water = await waterArea(tx, { geom: { type: "Point", coordinates: [position.lon, position.lat] }, center: position, isHarbour: false }, cfg.water);
      const resolved = await resolveOrigin(tx, { position, anchor: null, computedAnchor: null, water }, cfg.water);
      expect(resolved?.source).toBe("moved_off_land");
      expect(await distanceToLand(tx, resolved!.origin)).toBeGreaterThanOrEqual(19);
      const { rays } = await computeFetch(tx, resolved!.origin, cfg);
      expect(Math.min(...rays)).toBeGreaterThanOrEqual(15);
    }));

  it("review anchor beats computed anchor beats position", () =>
    withRollback(async (tx) => {
      await bayScene(tx);
      const position = await lonLatOf(tx, 0, 100);
      const review = await lonLatOf(tx, 100, 200);
      const computed = await lonLatOf(tx, -100, 150);
      const water = await waterArea(tx, { geom: { type: "Point", coordinates: [position.lon, position.lat] }, center: position, isHarbour: false }, cfg.water);
      const resolve = (anchor: { position: typeof position; origin: string | null } | null, computedAnchor: typeof position | null) =>
        resolveOrigin(tx, { position, anchor, computedAnchor, water }, cfg.water);

      expect(await resolve({ position: review, origin: "review" }, computed)).toEqual({ origin: review, source: "review_anchor" });
      // A stored computed anchor (earlier run) is not the origin; this run's computed anchor is.
      expect(await resolve({ position: review, origin: "computed" }, computed)).toEqual({ origin: computed, source: "computed_anchor" });
      expect(await resolve({ position: review, origin: "computed" }, null)).toEqual({ origin: position, source: "position" });
      expect(await resolve(null, null)).toEqual({ origin: position, source: "position" });
    }));

  it("a review anchor on land is moved into water", () =>
    withRollback(async (tx) => {
      await bayScene(tx);
      const position = await lonLatOf(tx, 0, 100);
      const water = await waterArea(tx, { geom: { type: "Point", coordinates: [position.lon, position.lat] }, center: position, isHarbour: false }, cfg.water);
      const resolved = await resolveOrigin(
        tx,
        { position, anchor: { position: await lonLatOf(tx, 0, 600), origin: "review" }, computedAnchor: null, water },
        cfg.water,
      );
      expect(resolved?.source).toBe("moved_off_land");
      const { y } = await utmOf(tx, resolved!.origin);
      near(y, 480, 2);
    }));
});

describe("synthetic helpers", () => {
  it("utm() builds a WKT point relative to E 500000 / N 3900000", () => {
    expect(utm(10, -20)).toBe("POINT(500010 3899980)");
  });
});
