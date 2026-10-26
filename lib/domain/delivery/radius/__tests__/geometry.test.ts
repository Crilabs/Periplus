import { describe, expect, it } from "vitest";
import type { Region } from "@/contract/v3_0";
import { getConfig } from "@/lib/config";
import { distanceNm, round5 } from "../../geo";
import { circleBbox, circlePolygon, destination, radiusNm, regionTouchesCircle, tileTouchesCircle } from "../geometry";

const cfg = getConfig().delivery.radius;
const CENTER = { lat: 35.25, lon: 21.105 };

/** `nm` nautical miles due north of `p`, five decimals. */
function northOf(p: { lat: number; lon: number }, nm: number) {
  const d = destination(p, 0, nm);
  return { lat: round5(d.lat), lon: round5(d.lon) };
}

/** A box north of the centre whose south edge is `nm` nautical miles away. */
function boxNorthAt(nm: number): NonNullable<Region["polygon"]> {
  const south = northOf(CENTER, nm).lat;
  const north = northOf(CENTER, nm + 10).lat;
  const [w, e] = [CENTER.lon - 0.2, CENTER.lon + 0.2];
  return { type: "Polygon", coordinates: [[[w, south], [e, south], [e, north], [w, north], [w, south]]] };
}

const region = (patch: Partial<Region>): Region => ({
  id: "rg_01J9ZD00000000000000000001",
  name: "Testregion",
  type: "island",
  center: { lat: 36, lon: 21.105 },
  radiusNm: 1,
  parentId: null,
  spotIds: [],
  profileVersion: 1,
  validFrom: "2026-10-01",
  ...patch,
});

describe("radius geometry", () => {
  it("radiusNm is nmPerDay × days × returnFactor within minDays…maxDays", () => {
    expect(radiusNm(7, cfg)).toBe(175);
    expect(radiusNm(1, cfg)).toBe(25);
    expect(radiusNm(28, cfg)).toBe(700);
    expect(() => radiusNm(0, cfg)).toThrow(RangeError);
    expect(() => radiusNm(29, cfg)).toThrow(RangeError);
    expect(() => radiusNm(2.5, cfg)).toThrow(RangeError);
  });

  it("circlePolygon is a closed counter-clockwise ring of geodesic points on the circle", () => {
    const circle = circlePolygon(CENTER, 175);
    const ring = circle.coordinates[0]!;
    expect(circle.type).toBe("Polygon");
    expect(ring).toHaveLength(65);
    expect(ring[0]).toEqual(ring[64]);
    for (const [lon, lat] of ring) {
      expect(Math.abs(distanceNm(CENTER, { lon: lon!, lat: lat! }) - 175)).toBeLessThanOrEqual(0.01);
      expect(Number(lon!.toFixed(5))).toBe(lon);
      expect(Number(lat!.toFixed(5))).toBe(lat);
    }
    // shoelace: positive area means counter-clockwise
    let area = 0;
    for (let i = 1; i < ring.length; i++) area += ring[i - 1]![0]! * ring[i]![1]! - ring[i]![0]! * ring[i - 1]![1]!;
    expect(area).toBeGreaterThan(0);
  });

  it("circleBbox holds the whole circle, rounded outward to five decimals", () => {
    const [w, s, e, n] = circleBbox(CENTER, 175);
    for (const [lon, lat] of circlePolygon(CENTER, 175, 256).coordinates[0]!) {
      expect(lon).toBeGreaterThanOrEqual(w);
      expect(lon).toBeLessThanOrEqual(e);
      expect(lat).toBeGreaterThanOrEqual(s);
      expect(lat).toBeLessThanOrEqual(n);
    }
    expect(distanceNm(CENTER, { lon: CENTER.lon, lat: n }) - 175).toBeLessThan(0.01);
    for (const v of [w, s, e, n]) expect(Number(v.toFixed(5))).toBe(v);
  });

  it("regionTouchesCircle with a polygon: just outside false, just inside true", () => {
    expect(regionTouchesCircle(region({ polygon: boxNorthAt(25.1) }), CENTER, 25)).toBe(false);
    expect(regionTouchesCircle(region({ polygon: boxNorthAt(24.9) }), CENTER, 25)).toBe(true);
  });

  it("regionTouchesCircle without a polygon uses centre and radius", () => {
    expect(regionTouchesCircle(region({ center: northOf(CENTER, 26.1), radiusNm: 1 }), CENTER, 25)).toBe(false);
    expect(regionTouchesCircle(region({ center: northOf(CENTER, 25.9), radiusNm: 1 }), CENTER, 25)).toBe(true);
  });

  it("tileTouchesCircle: the cell of the centre, a neighbour within reach, a far cell", () => {
    expect(tileTouchesCircle("q025:804:501", CENTER, 1)).toBe(true);
    // q025:804:502 starts at 35.5 N, 15 nm north of the centre
    expect(tileTouchesCircle("q025:804:502", CENTER, 14.9)).toBe(false);
    expect(tileTouchesCircle("q025:804:502", CENTER, 15.1)).toBe(true);
    expect(tileTouchesCircle("q025:900:600", CENTER, 175)).toBe(false);
  });
});
