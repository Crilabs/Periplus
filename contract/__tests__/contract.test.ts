import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
import { changeEntrySchema, coastFeatureSchema, highlightSchema, manifestSchema, regionSchema, spotSchema } from "@/contract/v2";
import { PUBLISHED_SCHEMAS, publishedJsonSchema } from "@/contract/schema/published";
import { TEIL_B_EXAMPLE } from "./fixtures";
import { SAMPLE_FILES } from "./samples";

const ex = TEIL_B_EXAMPLE;
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const omit = <T extends object, K extends keyof T>(o: T, key: K): Omit<T, K> => {
  const copy = { ...o };
  delete copy[key];
  return copy;
};

describe("Periplus Data Contract v2", () => {
  it("parses the Teil B example spot adapted to v2", () => {
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
    expect(regionSchema.safeParse({ ...region, parentId: "ar_01J9X4M0A1B2C3D4E5F6G7H8JA" }).success).toBe(false);
    expect(regionSchema.safeParse({ ...region, parentId: "rg_01J9X4KZ0A1B2C3D4E5F6G7H8J" }).success).toBe(true);
  });

  it("a sample of every contract file parses", () => {
    for (const file of CONTRACT_FILES) {
      const result = CONTRACT_SCHEMAS[file].safeParse(SAMPLE_FILES[file]);
      expect(result.error?.issues, file).toBeUndefined();
    }
  });

  it("names one JSON schema file per contract file", () => {
    expect(SCHEMA_VERSION).toBe("2.2");
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

  it.each(["1.0", "2.0", "2.1", "2.2"])("checked-in JSON schemas of %s equal the generated ones", (version) => {
    for (const f of CONTRACT_FILES) {
      expect(readJson(`contract/schema/${version}/${jsonSchemaFileName(f)}`), f).toEqual(
        contractJsonSchema(version, jsonSchemaFileName(f)),
      );
    }
  });

  it("2.0 names the subdivision where 1.0 named the area", () => {
    const manifest = SAMPLE_FILES["manifest.json"];
    expect(manifest.subdivision).toMatchObject({ key: "GR-I" });
    expect(manifestSchema.safeParse({ ...manifest, area: manifest.subdivision }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, subdivision: { ...manifest.subdivision, id: manifest.areas[0]!.id } }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, schemaVersion: "1.0" }).success).toBe(false);
    const envelopeOnly = { ...SAMPLE_FILES["spots.json"], area: manifest.areas[0]!.id };
    expect(CONTRACT_SCHEMAS["spots.json"].safeParse(envelopeOnly).success).toBe(false);
    const regions = SAMPLE_FILES["regions.json"];
    expect(CONTRACT_SCHEMAS["regions.json"].safeParse({ ...regions, subdivision: manifest.areas[0]!.id }).success).toBe(false);
  });

  it("the 2.0 manifest lists the touching areas by ar_ id", () => {
    const manifest = SAMPLE_FILES["manifest.json"];
    expect(manifestSchema.safeParse({ ...manifest, areas: [] }).success).toBe(true);
    expect(manifestSchema.safeParse(omit(manifest, "areas")).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, areas: [{ ...manifest.areas[0]!, id: "sd_01J9X4M0A1B2C3D4E5F6G7H8J9" }] }).success).toBe(false);
  });

  const IMAGE = {
    kind: "ai_illustration",
    slot: "title",
    file: `images/${ex.id}-title.jpg`,
    width: 1536,
    height: 1024,
    alt: { de: "KI-Illustration: Bucht mit Hängen" },
    light: "midday",
    observedAt: "2016-07-01",
    license: "periplus",
    attribution: "Luftbild © X · Gelände © Y · Illustration: Periplus",
    sourceUrl: null,
    camera: { position: [23.33, 37.6], heightM: 260, viewBearingDeg: 281.5, tiltDeg: 18, fovDeg: 50 },
  };

  it("2.1 spot validates with image and without", () => {
    expect(spotSchema.safeParse(ex).success).toBe(true);
    expect(spotSchema.safeParse({ ...ex, images: [IMAGE] }).success).toBe(true);
    expect(spotSchema.safeParse({ ...ex, images: [IMAGE, { ...IMAGE, slot: "view-1", file: `images/${ex.id}-view-1.jpg`, camera: null }] }).success).toBe(true);
    const highlight = SAMPLE_FILES["highlights.json"].highlights[0]!;
    const hlImage = { ...IMAGE, file: `images/${highlight.id}-title.jpg` };
    expect(highlightSchema.safeParse({ ...highlight, images: [hlImage] }).success).toBe(true);
    for (const [name, images] of [
      ["an empty list", []],
      ["a file outside images/", [{ ...IMAGE, file: "photo.jpg" }]],
      ["a region id in the file name", [{ ...IMAGE, file: "images/rg_01J9X4KZ0A1B2C3D4E5F6G7H8J-title.jpg" }]],
      ["a bearing of 360", [{ ...IMAGE, camera: { ...IMAGE.camera, viewBearingDeg: 360 } }]],
      ["an unknown field", [{ ...IMAGE, extra: 1 }]],
      ["an alt text of nothing", [{ ...IMAGE, alt: { de: "" } }]],
      ["a slot of nothing", [{ ...IMAGE, slot: "" }]],
    ] as const) {
      expect(spotSchema.safeParse({ ...ex, images }).success, name).toBe(false);
    }
  });

  it("2.2 validates highlightLevels", () => {
    expect(spotSchema.safeParse({ ...ex, highlightLevels: { culture: "many", food: "none", beach: "some" } }).success).toBe(true);
    expect(spotSchema.safeParse({ ...ex, highlightLevels: {} }).success).toBe(true);
    expect(spotSchema.safeParse(omit({ ...ex, highlightLevels: { food: "none" } }, "highlightLevels")).success).toBe(true);
    for (const [name, highlightLevels] of [
      ["an unknown level", { food: "lots" }],
      ["an unknown category", { museums: "some" }],
      ["a list", ["some"]],
    ] as const) {
      expect(spotSchema.safeParse({ ...ex, highlightLevels }).success, name).toBe(false);
    }
    // 2.1 does not know the field
    expect(JSON.stringify(contractJsonSchema("2.1", "spots.schema.json"))).not.toContain("highlightLevels");
    expect(JSON.stringify(contractJsonSchema("2.2", "spots.schema.json"))).toContain("highlightLevels");
  });

  it("the 2.1 manifest lists image files beside the contract files", () => {
    const manifest = SAMPLE_FILES["manifest.json"];
    const entry = { name: `images/${ex.id}-title.jpg`, sha256: "a".repeat(64), bytes: 10 };
    expect(manifestSchema.safeParse({ ...manifest, files: [...manifest.files, entry] }).success).toBe(true);
    expect(manifestSchema.safeParse({ ...manifest, files: [...manifest.files, { ...entry, name: "secret.jpg" }] }).success).toBe(false);
  });

  // the 2.0 files as published on 2026-10-19 (sha256 of the checked-in bytes): 2.1 is additive, 2.0 never changes
  const FROZEN_2_0: Record<string, string> = {
    "changes.schema.json": "9d76ca62e505a45e42e4560bf056fc2d4fa4a5cf784517a46bfff8e97c0487d6",
    "coast.schema.json": "278fd6907afd93f16f94663e301edd277ba3a5f09ee685a5ae6438073bbdaf47",
    "highlights.schema.json": "23433956130821c813c5a64857e31e7adf9f4421515177edf9d095a5d019ee5e",
    "manifest.schema.json": "e65467cb72f8f7b4e2d12f7e73a09da6b19fab9aac3751721fdcc5f212acc519",
    "regions.schema.json": "6a8aceb605480fb22788af83fb32ce53f000cc75148ea54e3517cff56fd3bf96",
    "spots.schema.json": "127749c51999f7d11234835d4624a8f8b23e8c7f54a1e94c90c4f05a38c91998",
    "weather-points.schema.json": "9c60f78a1f36e3f14f0b6c151dac7b71b4d28e2d48e7786090ed8f3180925071",
  };

  it("2.0 schema files are unchanged", () => {
    expect(readdirSync("contract/schema/2.0").sort()).toEqual(Object.keys(FROZEN_2_0).sort());
    for (const [file, sha] of Object.entries(FROZEN_2_0)) {
      expect(createHash("sha256").update(readFileSync(`contract/schema/2.0/${file}`)).digest("hex"), file).toBe(sha);
      expect(publishedJsonSchema("2.0", file), file).toEqual(readJson(`contract/schema/2.0/${file}`));
    }
    // and 2.0 still rejects what only 2.1 knows
    const spots20 = contractJsonSchema("2.0", "spots.schema.json") as { $defs?: unknown };
    expect(JSON.stringify(spots20)).not.toContain("images");
    expect(JSON.stringify(contractJsonSchema("2.1", "spots.schema.json"))).toContain("images");
  });

  // the 2.1 files as published on 2026-10-21: 2.2 is additive, 2.1 never changes
  const FROZEN_2_1: Record<string, string> = {
    "changes.schema.json": "24082f23f053ce6c100011d90e157c9e8a0df9bb2e305a7b4e8f96466da5dfd9",
    "coast.schema.json": "c1d8ce6edf126a97a3e3871e1eeff8135c2e3a0086bf8ed917cc51e16e0c39d9",
    "highlights.schema.json": "e2d8cdfaa65326cd2a26ee5f34e097180e7f8084435a44342478a4d76defc9b5",
    "manifest.schema.json": "aea97978f9dd76899e7c08350ac522504db9d1627b8b14db61c13a057911edec",
    "regions.schema.json": "052a6c75b26896743c10af319e3c86e59c829bb7ebd82da46dc00122f9b9ea03",
    "spots.schema.json": "579ec293c6aadcd7fb6630164a2eadb748857b23654b22acd66317a0335e23fe",
    "weather-points.schema.json": "e301bbfcd06b0c93d4895350f0e250e1393b42e0a337476ad65ae42fdf2b6f4d",
  };

  it("2.1 schema files are unchanged", () => {
    expect(readdirSync("contract/schema/2.1").sort()).toEqual(Object.keys(FROZEN_2_1).sort());
    for (const [file, sha] of Object.entries(FROZEN_2_1)) {
      expect(createHash("sha256").update(readFileSync(`contract/schema/2.1/${file}`)).digest("hex"), file).toBe(sha);
      expect(publishedJsonSchema("2.1", file), file).toEqual(readJson(`contract/schema/2.1/${file}`));
    }
  });

  it("a generated JSON schema carries its id and title", () => {
    expect(contractJsonSchema("2.2", "spots.schema.json")).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "periplus:contract/2.2/spots.schema.json",
      title: "Periplus Data Contract 2.2 – spots.json",
    });
  });

  it("every checked-in schema version is published, file by file, so older versions stay served (DAT-9)", () => {
    const versions = readdirSync("contract/schema", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(Object.keys(PUBLISHED_SCHEMAS).sort()).toEqual(versions.sort());
    for (const version of versions) {
      const files = readdirSync(`contract/schema/${version}`).filter((f) => f.endsWith(".schema.json"));
      expect(Object.keys(PUBLISHED_SCHEMAS[version]!).sort(), version).toEqual(files.sort());
      for (const file of files) expect(publishedJsonSchema(version, file), `${version}/${file}`).toEqual(readJson(`contract/schema/${version}/${file}`));
    }
    expect(Object.keys(PUBLISHED_SCHEMAS[SCHEMA_VERSION]!)).toEqual(CONTRACT_FILES.map(jsonSchemaFileName));
    for (const [version, file] of [["3.0", "spots.schema.json"], ["2.0", "spots.json"], ["1.0", "spots.json"], ["1.0", "constructor"], ["__proto__", "spots.schema.json"]]) {
      expect(publishedJsonSchema(version!, file!), `${version}/${file}`).toBeNull();
    }
  });

  it("an unknown version or file yields null", () => {
    expect(contractJsonSchema("3.0", "spots.schema.json")).toBeNull();
    expect(contractJsonSchema("2.0", "spots.json")).toBeNull();
    expect(contractJsonSchema("1.0", "../package.json")).toBeNull();
    expect(contractJsonSchema("__proto__", "spots.schema.json")).toBeNull();
  });
});
