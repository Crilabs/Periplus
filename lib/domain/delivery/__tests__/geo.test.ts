import { describe, expect, it } from "vitest";
import { distanceNm, distanceToLinesNm, pointInPolygon, round5 } from "../geo";

const square = (w: number, s: number, e: number, n: number): number[][] => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

describe("delivery geo helpers", () => {
  it("round5 keeps at most five decimals", () => {
    expect(round5(23.123456)).toBe(23.12346);
    expect(round5(0.1 + 0.2)).toBe(0.3);
    expect(round5(37)).toBe(37);
  });

  it("distanceNm of one minute of latitude is 1 nm ± 0.01", () => {
    const d = distanceNm({ lon: 23.3, lat: 37.5 }, { lon: 23.3, lat: 37.5 + 1 / 60 });
    expect(Math.abs(d - 1)).toBeLessThan(0.01);
    expect(distanceNm({ lon: 21, lat: 35 }, { lon: 21, lat: 35 })).toBe(0);
  });

  it("pointInPolygon respects holes and multipolygons", () => {
    const withHole: GeoJSON.Polygon = { type: "Polygon", coordinates: [square(0, 0, 10, 10), square(4, 4, 6, 6)] };
    expect(pointInPolygon({ lon: 2, lat: 2 }, withHole)).toBe(true);
    expect(pointInPolygon({ lon: 5, lat: 5 }, withHole)).toBe(false);
    expect(pointInPolygon({ lon: 11, lat: 5 }, withHole)).toBe(false);
    const multi: GeoJSON.MultiPolygon = { type: "MultiPolygon", coordinates: [withHole.coordinates, [square(20, 20, 21, 21)]] };
    expect(pointInPolygon({ lon: 20.5, lat: 20.5 }, multi)).toBe(true);
    expect(pointInPolygon({ lon: 5, lat: 5 }, multi)).toBe(false);
    expect(pointInPolygon({ lon: 15, lat: 15 }, multi)).toBe(false);
  });

  it("distanceToLinesNm is the distance to the nearest segment", () => {
    // a meridian 1' of longitude east of the point at the equator: 1 nm
    const line: GeoJSON.LineString = { type: "LineString", coordinates: [[1 / 60, -1], [1 / 60, 1]] };
    expect(distanceToLinesNm({ lon: 0, lat: 0 }, [line])).toBeCloseTo(1, 2);
    // beyond the segment's end the distance is to its end point
    const short: GeoJSON.MultiLineString = { type: "MultiLineString", coordinates: [[[0, 1 / 60], [0, 2 / 60]]] };
    expect(distanceToLinesNm({ lon: 0, lat: 0 }, [short, line])).toBeCloseTo(1, 2);
    expect(distanceToLinesNm({ lon: 0, lat: 0 }, [])).toBe(Number.POSITIVE_INFINITY);
  });
});
