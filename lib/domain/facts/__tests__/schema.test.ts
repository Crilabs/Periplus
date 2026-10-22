import { describe, expect, it } from "vitest";
import { SECTORS, SECTOR_CENTER_DEG } from "../schema-types";
import {
  attributeDef,
  canonicalJson,
  getFactSchema,
  InvalidFactValue,
  UnknownAttribute,
  validateFactValue,
} from "../schema";

const EXPECTED_M2_KEYS = [
  ...SECTORS.map((s) => `shelter.${s}`),
  "swell_protection",
  "opening_bearing",
  ...SECTORS.map((s) => `fetch.${s}`),
  "depth.min",
  "depth.max",
  "depth.anchoring_min",
  "depth.anchoring_max",
  "depth.approach",
  "seabed",
  "anchor_area",
  "anchor_position",
  "prohibitions",
];

describe("fact schema v1", () => {
  it("v1 place attributes are exactly the M2 keys", () => {
    expect(EXPECTED_M2_KEYS).toHaveLength(27);
    expect(getFactSchema("v1").levels.place.map((a) => a.key).sort()).toEqual([...EXPECTED_M2_KEYS].sort());
  });

  it("defaults to the active version and rejects an unknown one", () => {
    expect(getFactSchema().version).toBe("v3");
    expect(() => getFactSchema("v99")).toThrow(/v99/);
  });

  it("has only place attributes in v1", () => {
    const { levels } = getFactSchema("v1");
    expect([levels.area, levels.island, levels.cape_strait, levels.poi]).toEqual([[], [], [], []]);
  });

  it("sector centres run clockwise from north in 45° steps", () => {
    expect(SECTORS.map((s) => SECTOR_CENTER_DEG[s])).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
  });

  it("describes rules and origins", () => {
    expect(attributeDef("shelter.SW", "v1")).toMatchObject({ rule: "shelter", origins: ["computed", "text"] });
    expect(attributeDef("anchor_position", "v1")).toMatchObject({ rule: "review_over_computed", origins: ["computed", "observed"] });
    expect(attributeDef("prohibitions", "v1")).toMatchObject({ rule: "prohibitions", origins: ["computed"] });
    expect(attributeDef("fetch.N", "v1").rule).toBe("computed_only");
    expect(() => attributeDef("restriction", "v1")).toThrow(UnknownAttribute);
  });

  it("validates values", () => {
    expect(validateFactValue("shelter.N", 0.4, "v1")).toBe(0.4);
    expect(() => validateFactValue("shelter.N", 1.2, "v1")).toThrow(InvalidFactValue);
    expect(() => validateFactValue("seabed", [{ type: "sand", share: 0.8 }], "v1")).toThrow(InvalidFactValue);
    expect(validateFactValue("opening_bearing", { bearingDeg: null, widthDeg: 50 }, "v1")).toBeTruthy();
    expect(() => validateFactValue("shelter.X", 0.5, "v1")).toThrow(UnknownAttribute);
  });

  it("validates the structured values", () => {
    expect(() => validateFactValue("opening_bearing", { bearingDeg: 360, widthDeg: 50 }, "v1")).toThrow(InvalidFactValue);
    expect(() => validateFactValue("fetch.N", 120.5, "v1")).toThrow(InvalidFactValue);
    expect(() => validateFactValue("fetch.N", 50001, "v1")).toThrow(InvalidFactValue);
    expect(validateFactValue("fetch.N", 50000, "v1")).toBe(50000);
    expect(() => validateFactValue("depth.min", -1, "v1")).toThrow(InvalidFactValue);
    expect(validateFactValue("depth.approach", { at50m: 4, at100m: null, at200m: 12.5 }, "v1")).toBeTruthy();
    expect(
      validateFactValue("seabed", [
        { type: "sand", share: 0.7 },
        { type: "weed", share: 0.295 },
      ], "v1"),
    ).toHaveLength(2);
    expect(() => validateFactValue("seabed", [], "v1")).toThrow(InvalidFactValue);
    expect(() => validateFactValue("seabed", [{ type: "coral", share: 1 }], "v1")).toThrow(InvalidFactValue);
    expect(() => validateFactValue("anchor_position", { lon: 181, lat: 0 }, "v1")).toThrow(InvalidFactValue);
    const hit = {
      kind: "military",
      restrictedAreaId: "0199f0a4-1b2c-7d3e-8f40-123456789abc",
      sourceRef: null,
      share: 0.6,
      anchoringBan: true,
    };
    expect(validateFactValue("prohibitions", [hit], "v1")).toEqual([hit]);
    expect(validateFactValue("prohibitions", [], "v1")).toEqual([]);
    expect(() => validateFactValue("prohibitions", [{ ...hit, kind: "harbour" }], "v1")).toThrow(InvalidFactValue);
  });

  it("names the key and the zod issues in the error", () => {
    expect(() => validateFactValue("shelter.N", 1.2, "v1")).toThrow(/shelter\.N.*1/);
  });
});

describe("canonicalJson", () => {
  it("sorts keys recursively and leaves no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: null }], c: "s" } })).toBe(
      '{"a":{"c":"s","d":[3,{"x":null,"y":1}]},"b":1}',
    );
  });

  it("is independent of key order", () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalJson({ b: { d: 3, c: 2 }, a: 1 }));
  });
});
