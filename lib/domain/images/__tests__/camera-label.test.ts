import { describe, expect, it } from "vitest";
import { imageTypeLabel, pointLabel } from "../camera-label";

describe("image type label", () => {
  it("names the kind in German, a town nearby does not change it", () => {
    expect(imageTypeLabel({ kind: "anchorage" })).toBe("Ankerplatz");
    expect(imageTypeLabel({ kind: "mooring_field" })).toBe("Bojenfeld");
    expect(imageTypeLabel({ kind: "marina" })).toBe("Marina");
    expect(imageTypeLabel({ kind: "port" })).toBe("Hafen");
  });

  it("formats a point like the place page: latitude, longitude with five decimals", () => {
    expect(pointLabel({ lon: 27.97, lat: 34.97 })).toBe("34.97000, 27.97000");
    expect(pointLabel({ lon: 19.370004, lat: 36.61 })).toBe("36.61000, 19.37000");
  });
});
