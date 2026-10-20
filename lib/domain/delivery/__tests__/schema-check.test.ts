import { describe, expect, it } from "vitest";
import { CONTRACT_FILES } from "@/contract";
import { spotsFile, TEIL_B_EXAMPLE } from "@/contract/__tests__/fixtures";
import { SAMPLE_FILES } from "@/contract/__tests__/samples";
import { checkJsonSchema } from "../schema-check";

const ex = TEIL_B_EXAMPLE;

describe("checkJsonSchema", () => {
  it("ajv accepts a valid spots file and reports the path of a bad sector", () => {
    expect(checkJsonSchema("spots.json", spotsFile([ex]))).toEqual([]);
    const bad = { ...ex, shelter: { ...ex.shelter, sectors: { ...ex.shelter.sectors, N: 1.2 } } };
    expect(checkJsonSchema("spots.json", spotsFile([bad]))[0]!.path).toBe("/spots/0/shelter/sectors/N");
  });

  it("accepts the sample of every contract file", () => {
    for (const file of CONTRACT_FILES) expect(checkJsonSchema(file, SAMPLE_FILES[file]), file).toEqual([]);
  });

  it("reports every error, foreign fields and wrong formats included", () => {
    const bad = { ...ex, rating: 4.5, validFrom: "15.10.2026", sources: [{ url: "no url", kind: "tripReport", observedAt: "2025-06-10" }] };
    const errors = checkJsonSchema("spots.json", spotsFile([bad]));
    expect(errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(["/spots/0", "/spots/0/validFrom", "/spots/0/sources/0/url"]),
    );
    expect(errors.find((e) => e.path === "/spots/0")!.message).toMatch(/additional properties/);
  });

  it("the published schemas reject non-http source links and foreign provenance sources", () => {
    const bad = {
      ...ex,
      shelter: { ...ex.shelter, source: "navily" },
      sources: [
        { url: "upload://" + "a".repeat(64), kind: "pilotGuide", observedAt: "2025-06-10" },
        { url: "javascript:alert(1)", kind: "forum", observedAt: "2025-06-10" },
      ],
    };
    const paths = checkJsonSchema("spots.json", spotsFile([bad])).map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining(["/spots/0/shelter/source", "/spots/0/sources/0/url", "/spots/0/sources/1/url"]),
    );
  });

  it("the published schemas take combined sources in contract order only", () => {
    const paths = (source: string) =>
      checkJsonSchema("spots.json", spotsFile([{ ...ex, shelter: { ...ex.shelter, source } }])).map((e) => e.path);
    expect(paths("computed+text")).toEqual([]);
    expect(paths("text+computed")).toContain("/spots/0/shelter/source");
    expect(paths("text+text")).toContain("/spots/0/shelter/source");
  });

  it("reports a wrong envelope at the root", () => {
    const errors = checkJsonSchema("spots.json", { ...spotsFile([]), schemaVersion: "1.0" });
    expect(errors).toEqual([expect.objectContaining({ path: "/schemaVersion" })]);
    expect(checkJsonSchema("coast.geojson", { type: "FeatureCollection" })).toEqual([
      expect.objectContaining({ path: "" }),
    ]);
  });
});
