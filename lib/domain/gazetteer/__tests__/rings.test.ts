import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { landRings, ringBoxes, withinRing, type RingCenter } from "@/lib/domain/gazetteer/rings";

/* The two rings of the stage `gazetteer.land` around the candidates (N7 4.4, 4.6): radii from N4a, boxes, distance. */

const M_PER_DEG_LAT = 111_195;
const LAT = 35.2;
const LON = 21.0;
const eastM = (m: number) => LON + m / (M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180));
const northM = (m: number) => LAT + m / M_PER_DEG_LAT;
const center = (placeId: string, lon: number, lat: number): RingCenter => ({ placeId, lon, lat });

describe("landRings", () => {
  it("derives the radii from the N4a state values plus the margin", () => {
    expect(landRings(getConfig().research.state, 300)).toEqual({ nearM: 2400, farM: 15900 });
  });
});

describe("ringBoxes", () => {
  it("three centers 1 km apart: one box covering all three plus the radius", () => {
    const centers = [center("a", LON, LAT), center("b", eastM(1000), LAT), center("c", eastM(2000), LAT)];
    const boxes = ringBoxes(centers, 2400, 40);
    expect(boxes).toHaveLength(1);
    const [west, south, east, north] = boxes[0]!;
    expect(west).toBeLessThan(LON);
    expect(east).toBeGreaterThan(eastM(2000));
    expect(south).toBeCloseTo(northM(-2400), 3);
    expect(north).toBeCloseTo(northM(2400), 3);
    expect(withinRing({ lon: west, lat: LAT }, [centers[0]!], 2410)).toBe(true);
    expect(withinRing({ lon: east, lat: LAT }, [centers[2]!], 2410)).toBe(true);
    expect(withinRing({ lon: west, lat: LAT }, [centers[0]!], 2390)).toBe(false);
  });

  it("two centers 100 km apart: two boxes, each center in one", () => {
    const centers = [center("a", LON, LAT), center("b", eastM(100_000), LAT)];
    const boxes = ringBoxes(centers, 2400, 40);
    expect(boxes).toHaveLength(2);
    for (const c of centers) {
      const inside = boxes.filter(([w, s, e, n]) => c.lon >= w && c.lon <= e && c.lat >= s && c.lat <= n);
      expect(inside).toHaveLength(1);
    }
  });

  it("no centers: no boxes", () => {
    expect(ringBoxes([], 2400, 40)).toEqual([]);
  });
});

describe("withinRing", () => {
  it("2,300 m from the center is within 2,400 m, 2,500 m is not", () => {
    const centers = [center("a", LON, LAT)];
    expect(withinRing({ lon: LON, lat: northM(2300) }, centers, 2400)).toBe(true);
    expect(withinRing({ lon: LON, lat: northM(2500) }, centers, 2400)).toBe(false);
    expect(withinRing({ lon: eastM(2300), lat: LAT }, centers, 2400)).toBe(true);
  });
});
