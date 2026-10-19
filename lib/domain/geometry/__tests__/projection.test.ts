import { describe, expect, it } from "vitest";
import { utmSridFor } from "../projection";

describe("utmSridFor", () => {
  it("returns the northern UTM zone of the longitude", () => {
    expect(utmSridFor(23.4, 37.7)).toBe(32634);
    expect(utmSridFor(21.0, 35.2)).toBe(32634);
    expect(utmSridFor(17.99, 40)).toBe(32633);
  });

  it("puts a longitude on a zone edge into the eastern zone", () => {
    expect(utmSridFor(18.0, 40)).toBe(32634);
    expect(utmSridFor(-180, 10)).toBe(32601);
  });

  it("keeps longitude 180 in zone 60", () => {
    expect(utmSridFor(180, 10)).toBe(32660);
  });

  it("uses the southern zone below the equator", () => {
    expect(utmSridFor(23.4, -0.1)).toBe(32734);
    expect(utmSridFor(23.4, 0)).toBe(32634);
  });
});
