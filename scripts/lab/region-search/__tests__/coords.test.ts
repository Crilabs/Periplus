import { describe, expect, it } from "vitest";
import { coordinatesIn, parseCoordinate } from "../coords";

describe("parseCoordinate", () => {
  it("reads degrees and minutes with hemisphere letters", () => {
    const c = parseCoordinate("37°31'N 23°27'E");
    expect(c?.lat).toBeCloseTo(37.5167, 3);
    expect(c?.lon).toBeCloseTo(23.45, 3);
    expect(c?.precisionM).toBe(900);
  });

  it("reads decimal minutes with a space after the degree sign", () => {
    const c = parseCoordinate("37° 31.5' N, 23° 27.1' E");
    expect(c?.lat).toBeCloseTo(37.525, 3);
    expect(c?.lon).toBeCloseTo(23.4517, 3);
    expect(c?.precisionM).toBe(90);
  });

  it("reads decimal degrees; the pair is as precise as its coarser component", () => {
    const c = parseCoordinate("37.5167, 23.45");
    expect(c?.lat).toBeCloseTo(37.5167, 4);
    expect(c?.lon).toBeCloseTo(23.45, 4);
    expect(c?.precisionM).toBe(1000);
    expect(parseCoordinate("37.5167, 23.4500")?.precisionM).toBe(10);
  });

  it("reads decimal degrees with a comma as decimal mark and a degree sign", () => {
    const c = parseCoordinate("37,5167° N 23,4500° E");
    expect(c?.lat).toBeCloseTo(37.5167, 4);
    expect(c?.lon).toBeCloseTo(23.45, 4);
  });

  it("reads the N37 31.500 E023 27.100 form", () => {
    const c = parseCoordinate("N37 31.500 E023 27.100");
    expect(c?.lat).toBeCloseTo(37.525, 4);
    expect(c?.lon).toBeCloseTo(23.4517, 4);
    expect(c?.precisionM).toBe(1);
  });

  it("rejects years, prices and other number pairs", () => {
    expect(parseCoordinate("in 2024")).toBeNull();
    expect(parseCoordinate("37,50 €")).toBeNull();
    expect(parseCoordinate("ISBN 978-3-16-148410-0")).toBeNull();
    expect(parseCoordinate("Tel. 22980 22274")).toBeNull();
    expect(parseCoordinate("52.5200, 13.4050")).toBeNull(); // outside the eastern Mediterranean window
  });
});

describe("coordinatesIn", () => {
  it("finds every pair in a markdown text", () => {
    const md = "We anchored at 37°31'N 23°27'E in 5 m. The next day: 37.4990, 23.4600 (sand). Price 37,50 € in 2024.";
    const found = coordinatesIn(md);
    expect(found).toHaveLength(2);
    expect(found[0]?.text).toBe("37°31'N 23°27'E");
    expect(found[1]?.lat).toBeCloseTo(37.499, 3);
  });
});
