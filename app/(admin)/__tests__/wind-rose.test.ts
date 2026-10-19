import { describe, expect, it } from "vitest";
import { shelterColor, wedge, wedgePath } from "../_components/wind-rose-math";

describe("wind rose math", () => {
  it("wedge N spans -22.5° to 22.5° with r = value × radius", () => {
    expect(wedge("N", 1, 100)).toEqual({ startDeg: -22.5, endDeg: 22.5, r: 100 });
    expect(wedge("E", 0.5, 100).r).toBe(50);
    expect(wedge("E", 0.5, 100)).toMatchObject({ startDeg: 67.5, endDeg: 112.5 });
    expect(wedge("NW", 0, 100).r).toBe(0);
  });

  it("wedgePath starts at the centre, N points up and runs clockwise", () => {
    // Centre (100, 100), radius 100: N wedge from bearing -22.5° to 22.5° above the centre.
    const path = wedgePath("N", 1, 100, 100, 100);
    const nums = path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(path.startsWith("M 100 100 L ")).toBe(true);
    const [, , x1, y1] = nums;
    const [x2, y2] = nums.slice(-2);
    expect(x1).toBeCloseTo(100 - 100 * Math.sin((22.5 * Math.PI) / 180), 2);
    expect(y1).toBeCloseTo(100 - 100 * Math.cos((22.5 * Math.PI) / 180), 2);
    expect(x2).toBeCloseTo(100 + 100 * Math.sin((22.5 * Math.PI) / 180), 2);
    expect(y2).toBeCloseTo(y1!, 2);
    expect(path).toContain(" A 100 100 0 0 1 ");
    // E wedge lies right of the centre.
    const east = wedgePath("E", 1, 100, 100, 100).match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(east[2]).toBeGreaterThan(190);
    expect(wedgePath("S", 0, 100, 100, 100)).toBe("");
  });

  it("shelterColor runs from red (0) to green (1)", () => {
    expect(shelterColor(0)).toBe("hsl(0 75% 45%)");
    expect(shelterColor(1)).toBe("hsl(120 75% 45%)");
    expect(shelterColor(2)).toBe("hsl(120 75% 45%)");
  });
});
