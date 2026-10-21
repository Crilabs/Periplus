import { describe, expect, it } from "vitest";
import { imageTypeLabel, pointLabel } from "../camera-label";

describe("image type label", () => {
  it("names the composition and the kind in German", () => {
    expect(imageTypeLabel({ kind: "anchorage", town: null }, null)).toBe("Ankerplatz");
    expect(imageTypeLabel({ kind: "mooring_field", town: null }, null)).toBe("Bojenfeld");
    expect(imageTypeLabel({ kind: "marina", town: null }, null)).toBe("Marina");
    expect(imageTypeLabel({ kind: "port", town: null }, null)).toBe("Hafen");
    const town = { geoObjectId: "00000000-0000-7000-8000-000000000003", lon: 23.4535, lat: 37.4985 };
    expect(imageTypeLabel({ kind: "anchorage", town }, "Poros")).toBe("Ankerplatz bei einem Ort – Poros");
    expect(imageTypeLabel({ kind: "mooring_field", town }, null)).toBe("Ankerplatz bei einem Ort – ohne Namen");
    // a marina or port keeps its own composition with a town nearby (compositionFor)
    expect(imageTypeLabel({ kind: "marina", town }, "Poros")).toBe("Marina");
    expect(imageTypeLabel({ kind: "port", town }, "Poros")).toBe("Hafen");
  });

  it("formats a point like the place page: latitude, longitude with five decimals", () => {
    expect(pointLabel({ lon: 27.97, lat: 34.97 })).toBe("34.97000, 27.97000");
    expect(pointLabel({ lon: 19.370004, lat: 36.61 })).toBe("36.61000, 19.37000");
  });
});
