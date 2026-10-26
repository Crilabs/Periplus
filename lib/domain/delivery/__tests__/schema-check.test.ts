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

  it("the published manifest schema ties dataVersion to the coverage status (delivered has one, missing none)", () => {
    const manifest = SAMPLE_FILES["manifest.json"] as { coverage: Array<Record<string, unknown>> };
    const withEntry = (entry: Record<string, unknown>) => ({ ...manifest, coverage: [{ ...manifest.coverage[0]!, ...entry }] });
    expect(checkJsonSchema("manifest.json", withEntry({ status: "delivered", dataVersion: 3 }))).toEqual([]);
    expect(checkJsonSchema("manifest.json", withEntry({ status: "missing", dataVersion: null }))).toEqual([]);
    expect(checkJsonSchema("manifest.json", withEntry({ status: "missing", dataVersion: 3 }))).not.toEqual([]);
    expect(checkJsonSchema("manifest.json", withEntry({ status: "delivered", dataVersion: null }))).not.toEqual([]);
  });

  it("reports every error, foreign fields and wrong formats included", () => {
    const bad = { ...ex, rating: 4.5, sources: [{ url: "https://example.org", kind: "tripReport", observedAt: "2025-06-10" }], asOf: "15.10.2026" };
    const errors = checkJsonSchema("spots.json", spotsFile([bad]));
    expect(errors.map((e) => e.path)).toEqual(expect.arrayContaining(["/spots/0", "/spots/0/asOf"]));
    expect(errors.filter((e) => e.path === "/spots/0").map((e) => e.message).join(" ")).toMatch(/additional properties/);
  });

  it("the published schemas reject the 3.0 fields of a spot (sources, summary, version fields, highlight ids)", () => {
    const paths = (extra: Record<string, unknown>) => checkJsonSchema("spots.json", spotsFile([{ ...ex, ...extra }])).map((e) => e.path);
    for (const field of ["sources", "summary", "profileVersion", "validFrom", "highlightIds", "highlightLevels"]) {
      expect(paths({ [field]: field === "sources" ? [] : "x" }), field).toContain("/spots/0");
    }
  });

  it("the published schemas reject non-http contact links and foreign provenance sources", () => {
    const bad = {
      ...ex,
      shelter: { ...ex.shelter, source: "navily" },
      contact: { vhf: null, phone: null, url: "upload://" + "a".repeat(64) },
    };
    const paths = checkJsonSchema("spots.json", spotsFile([bad])).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["/spots/0/shelter/source", "/spots/0/contact/url"]));
    const js = checkJsonSchema("spots.json", spotsFile([{ ...ex, contact: { vhf: null, phone: null, url: "javascript:alert(1)" } }])).map((e) => e.path);
    expect(js).toContain("/spots/0/contact/url");
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
