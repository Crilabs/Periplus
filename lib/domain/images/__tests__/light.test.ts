import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { PlaceKind } from "@/lib/db/schema";
import { compositionFor, lightFor } from "../light";
import type { PlaceImageInput } from "../place-input";

const cfg = getConfig().images;
const TOWN = { geoObjectId: "00000000-0000-7000-8000-000000000001", lon: 21.01, lat: 35.2 };

function input(kind: PlaceKind, town: PlaceImageInput["town"] = null): PlaceImageInput {
  return {
    geoObjectId: "00000000-0000-7000-8000-000000000002",
    publicId: null,
    kind,
    lon: 21.0,
    lat: 35.2,
    country: "GR",
    subdivisionKey: null,
    openingBearing: null,
    rays: null,
    town,
    cove: null,
  };
}

describe("light rule", () => {
  it("anchorage and mooring field without a town → midday, open_water", () => {
    for (const kind of ["anchorage", "mooring_field"] as const) {
      expect(lightFor(input(kind), cfg)).toBe("midday");
      expect(compositionFor(input(kind))).toBe("open_water");
    }
  });

  it("marina and port → evening, open_water", () => {
    for (const kind of ["marina", "port"] as const) {
      expect(lightFor(input(kind), cfg)).toBe("evening");
      expect(compositionFor(input(kind))).toBe("open_water");
    }
  });

  it("anchorage or mooring field with a town → midday, near_town", () => {
    for (const kind of ["anchorage", "mooring_field"] as const) {
      expect(lightFor(input(kind, TOWN), cfg)).toBe("midday");
      expect(compositionFor(input(kind, TOWN))).toBe("near_town");
    }
  });

  it("marina near a town stays evening, open_water", () => {
    expect(lightFor(input("marina", TOWN), cfg)).toBe("evening");
    expect(compositionFor(input("marina", TOWN))).toBe("open_water");
  });
});
