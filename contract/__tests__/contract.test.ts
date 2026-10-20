import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ExcludeReason } from "@/lib/domain/consolidation/exclude";
import {
  CONTRACT_FILES,
  CONTRACT_SCHEMAS,
  contractJsonSchema,
  jsonSchemaFileName,
  SCHEMA_VERSION,
  type Spot,
} from "@/contract";
import { changeEntrySchema, coastFeatureSchema, highlightSchema, manifestSchema, regionSchema, spotSchema } from "@/contract/v1";
import { TEIL_B_EXAMPLE } from "./fixtures";
import { SAMPLE_FILES } from "./samples";

const ex = TEIL_B_EXAMPLE;
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const omit = <T extends object, K extends keyof T>(o: T, key: K): Omit<T, K> => {
  const copy = { ...o };
  delete copy[key];
  return copy;
};

describe("Periplus Data Contract v1", () => {
  it("parses the Teil B example spot adapted to v1", () => {
    // Example of .idea/datendienst-spec.md Teil B; adaptations: regionId and highlight id as valid 26-char ULIDs
    expect(spotSchema.parse(TEIL_B_EXAMPLE).shelter.sectors.NW).toBe(0.95);
  });

  it.each([
    ["kind mooring", { kind: "mooring" }],
    ["seven sectors", { shelter: { ...ex.shelter, sectors: omit(ex.shelter.sectors, "NW") } }],
    ["nine sectors", { shelter: { ...ex.shelter, sectors: { ...ex.shelter.sectors, NNW: 0.5 } } }],
    ["six decimals", { position: { lat: 37.608121, lon: 23.33945 } }],
    ["a latitude beyond 90", { position: { lat: 90.5, lon: 23.33945 } }],
    ["legacy id", { id: "navily_123" }],
    ["an id with a non-Crockford character", { id: "sp_01J9X4K2M7Q8R5T6V7W8X9Y0ZL" }],
    ["an unknown field", { rating: 4.5 }],
    ["a missing profile version", { profileVersion: undefined }],
    ["profile version 0", { profileVersion: 0 }],
    ["a validFrom datetime", { validFrom: "2026-10-15T00:00:00Z" }],
    ["holding moderate (internal vocabulary)", { holding: "moderate" }],
    ["an excluded reason outside the list", { exclude: { excluded: true, reason: "firing_area", detail: null } }],
    ["an empty summary", { summary: { de: "" } }],
    ["a source kind in snake case", { sources: [{ url: "https://example.org/a", kind: "trip_report", observedAt: "2025-06-10" }] }],
    ["month 13 in a season note", { seasonNote: [{ months: [13], text: "x" }] }],
    ["a merged spot pointing at a highlight", { mergedInto: "hl_01J9X4KQ3P2N1M0Z9K8J7H6G5F" }],
    ["an upload:// source", { sources: [{ url: "upload://" + "a".repeat(64), kind: "pilotGuide", observedAt: "2025-06-10" }] }],
    ["a javascript: source", { sources: [{ url: "javascript:alert(1)", kind: "forum", observedAt: "2025-06-10" }] }],
    ["an upper-case scheme", { sources: [{ url: "HTTPS://example.org/a", kind: "forum", observedAt: "2025-06-10" }] }],
    ["a shelter source outside the provenance vocabulary", { shelter: { ...ex.shelter, source: "computed+navily" } }],
    ["a depth source with a trailing +", { depth: { ...ex.depth, source: "text+" } }],
    ["a shelter source out of contract order", { shelter: { ...ex.shelter, source: "text+computed" } }],
    ["a depth source with a duplicate", { depth: { ...ex.depth, source: "text+text" } }],
  ])("rejects %s", (_name, patch) => {
    expect(spotSchema.safeParse({ ...ex, ...patch }).success).toBe(false);
  });

  it("manifest licences take http(s) links only; coast reasons know no firingArea", () => {
    const manifest = SAMPLE_FILES["manifest.json"];
    const withUrl = (url: string) => ({ ...manifest, licenses: [{ ...manifest.licenses[0]!, url }] });
    expect(manifestSchema.safeParse(withUrl("http://example.org/odbl")).success).toBe(true);
    expect(manifestSchema.safeParse(withUrl("upload://abc")).success).toBe(false);
    expect(manifestSchema.safeParse(withUrl("javascript:alert(1)")).success).toBe(false);
    const coast = SAMPLE_FILES["coast.geojson"];
    const restricted = coast.features.find((f) => f.properties.kind === "restrictedArea")!;
    const firing = { ...restricted, properties: { ...restricted.properties, reason: "firingArea" } };
    expect(coastFeatureSchema.safeParse(firing).success).toBe(false);
  });

  it("a change entry's id prefix matches its object type", () => {
    const entry = SAMPLE_FILES["changes.json"].changes[0]!;
    expect(changeEntrySchema.safeParse(entry).success).toBe(true);
    expect(changeEntrySchema.safeParse({ ...entry, objectType: "highlight" }).success).toBe(false);
    expect(changeEntrySchema.safeParse({ ...entry, objectType: "region" }).success).toBe(false);
  });

  it("accepts a spot with only the required fields", () => {
    const required = {
      id: ex.id,
      kind: "port",
      name: "Limani",
      position: ex.position,
      shelter: ex.shelter,
      limits: ex.limits,
      exclude: { excluded: true, reason: "military", detail: "Militärisches Sperrgebiet" },
      score: { confidence: 0.2, popularity: 0, quietness: null, sourcesCount: 0, lastObserved: null },
      provenance: {},
      mergedInto: null,
      profileVersion: 1,
      validFrom: "2026-10-19",
    };
    expect(spotSchema.safeParse(required).success).toBe(true);
    expect(spotSchema.safeParse(omit(required, "exclude")).success).toBe(false);
  });

  it("the contract exclusion reasons are exactly the consolidation's ExcludeReason", () => {
    expectTypeOf<NonNullable<Spot["exclude"]["reason"]>>().toEqualTypeOf<ExcludeReason>();
  });

  it("highlights and regions reject foreign ids and unknown enum values", () => {
    const highlight = SAMPLE_FILES["highlights.json"].highlights[0]!;
    expect(highlightSchema.safeParse(highlight).success).toBe(true);
    expect(highlightSchema.safeParse({ ...highlight, category: "anchorage" }).success).toBe(false);
    expect(highlightSchema.safeParse({ ...highlight, importance: 6 }).success).toBe(false);
    expect(highlightSchema.safeParse({ ...highlight, spotIds: ["rg_01J9X4KZ0A1B2C3D4E5F6G7H8J"] }).success).toBe(false);
    const region = SAMPLE_FILES["regions.json"].regions[0]!;
    expect(regionSchema.safeParse(region).success).toBe(true);
    expect(regionSchema.safeParse({ ...region, type: "coast_section" }).success).toBe(false);
    expect(regionSchema.safeParse({ ...region, radiusNm: 0 }).success).toBe(false);
    expect(regionSchema.safeParse({ ...region, parentId: "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z1" }).success).toBe(false);
  });

  it("a sample of every contract file parses", () => {
    for (const file of CONTRACT_FILES) {
      const result = CONTRACT_SCHEMAS[file].safeParse(SAMPLE_FILES[file]);
      expect(result.error?.issues, file).toBeUndefined();
    }
  });

  it("names one JSON schema file per contract file", () => {
    expect(SCHEMA_VERSION).toBe("1.0");
    expect(CONTRACT_FILES.map(jsonSchemaFileName)).toEqual([
      "manifest.schema.json",
      "spots.schema.json",
      "highlights.schema.json",
      "regions.schema.json",
      "coast.schema.json",
      "weather-points.schema.json",
      "changes.schema.json",
    ]);
  });

  it("checked-in JSON schemas equal the generated ones", () => {
    for (const f of CONTRACT_FILES) {
      expect(readJson(`contract/schema/1.0/${jsonSchemaFileName(f)}`), f).toEqual(
        contractJsonSchema("1.0", jsonSchemaFileName(f)),
      );
    }
  });

  it("a generated JSON schema carries its id and title", () => {
    expect(contractJsonSchema("1.0", "spots.schema.json")).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "periplus:contract/1.0/spots.schema.json",
      title: "Periplus Data Contract 1.0 – spots.json",
    });
  });

  it("an unknown version or file yields null", () => {
    expect(contractJsonSchema("2.0", "spots.schema.json")).toBeNull();
    expect(contractJsonSchema("1.0", "spots.json")).toBeNull();
    expect(contractJsonSchema("1.0", "../package.json")).toBeNull();
  });
});
