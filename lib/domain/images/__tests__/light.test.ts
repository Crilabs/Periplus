import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { PlaceKind } from "@/lib/db/schema";
import { lightFor } from "../light";
import type { PlaceImageInput } from "../place-input";
import type { RenderCamera } from "../render-plan";

const cfg = getConfig().images;
const LON = 21.0;
const LAT = 35.2;
const KY = 110_540;
const KX = 111_320 * Math.cos((LAT * Math.PI) / 180);
const town = (east: number, north: number) => ({ geoObjectId: "00000000-0000-7000-8000-000000000001", lon: LON + east / KX, lat: LAT + north / KY });

function input(kind: PlaceKind, t: PlaceImageInput["town"] = null): PlaceImageInput {
  return {
    geoObjectId: "00000000-0000-7000-8000-000000000002",
    publicId: null,
    kind,
    lon: LON,
    lat: LAT,
    country: "GR",
    subdivisionKey: null,
    openingBearing: null,
    rays: null,
    town: t,
    cove: null,
  };
}

/** 365 m up, 40° tilt, south of the place looking north at it. */
const camera: RenderCamera = {
  target: [LON, LAT],
  azimuthDeg: 180,
  heightM: 365,
  distanceM: 365 / Math.tan((40 * Math.PI) / 180),
  tiltDeg: 40,
  fovDeg: cfg.camera.fovDeg,
  width: cfg.camera.width,
  height: cfg.camera.height,
  zoom: "z2",
};

describe("light rule (spec 19)", () => {
  it("anchorage and mooring field without a town → midday", () => {
    for (const kind of ["anchorage", "mooring_field"] as const) expect(lightFor(input(kind), camera, cfg)).toBe("midday");
  });

  it("an anchorage with a town in frame is evening, with the town outside the frame midday", () => {
    expect(lightFor(input("anchorage", town(0, 300)), camera, cfg)).toBe("evening");
    expect(lightFor(input("mooring_field", town(0, 300)), camera, cfg)).toBe("evening");
    expect(lightFor(input("anchorage", town(1_400, 0)), camera, cfg)).toBe("midday");
  });

  it("without a camera an anchorage near a town stays midday", () => {
    expect(lightFor(input("anchorage", town(0, 300)), null, cfg)).toBe("midday");
  });

  it("marina and port are evening, with or without a camera", () => {
    for (const kind of ["marina", "port"] as const) {
      expect(lightFor(input(kind), camera, cfg)).toBe("evening");
      expect(lightFor(input(kind), null, cfg)).toBe("evening");
    }
  });
});
