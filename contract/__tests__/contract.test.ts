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
  type SpotBody,
} from "@/contract";
import {
  changesResponseSchema,
  coastFeatureSchema,
  coverageEntry,
  factSchema,
  manifestSchema,
  nearbyCategory,
  regionSchema,
  spotSchema,
} from "@/contract/v2";
import * as v30 from "@/contract/v3_0";
import { PUBLISHED_SCHEMAS, publishedJsonSchema } from "@/contract/schema/published";
import { TEIL_B_EXAMPLE } from "./fixtures";
import { SAMPLE_FILES } from "./samples";
import { SAMPLE_FILES as SAMPLE_FILES_V3_0 } from "./samples-v3_0";
import { TEIL_B_EXAMPLE as TEIL_B_V3_0 } from "./fixtures-v3_0";

const ex = TEIL_B_EXAMPLE;
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const omit = <T extends object, K extends keyof T>(o: T, key: K): Omit<T, K> => {
  const copy = { ...o };
  delete copy[key];
  return copy;
};

/** The files of every version before 4.0 (highlights and change feed included). */
const SCHEMAS_3_0: Record<(typeof v30.CONTRACT_FILES)[number], { safeParse: (v: unknown) => { error?: { issues: unknown } } }> = {
  "manifest.json": v30.manifestSchema,
  "spots.json": v30.spotsFileSchema,
  "highlights.json": v30.highlightsFileSchema,
  "regions.json": v30.regionsFileSchema,
  "coast.geojson": v30.coastCollectionSchema,
  "weather-points.json": v30.weatherPointsFileSchema,
  "changes.json": v30.changesFileSchema,
};

const LEGACY_FILES = [
  "manifest.json",
  "spots.json",
  "highlights.json",
  "regions.json",
  "coast.geojson",
  "weather-points.json",
  "changes.json",
] as const;

const SUBDIVISION_ID = "sd_01J9X4M0A1B2C3D4E5F6G7H8J9";
const SPOT_M = "sp_01J9ZD00000000000000000002";
/** A closed ring of five positions with five decimals. */
const CIRCLE_FIXTURE = {
  type: "Polygon" as const,
  coordinates: [
    [
      [23.4, 38.1],
      [24.3, 37.5],
      [23.4, 36.9],
      [22.5, 37.5],
      [23.4, 38.1],
    ],
  ],
};

describe("Periplus Data Contract 4.0", () => {
  it("4.0 manifest takes a subdivision scope and a radius scope", () => {
    const base = SAMPLE_FILES["manifest.json"];
    expect(manifestSchema.safeParse(base).success).toBe(true);
    const radius = {
      ...base,
      scope: {
        type: "radius",
        key: "0123456789abcdef",
        homeMarina: { id: SPOT_M, name: "Marina" },
        center: { lat: 37.5, lon: 23.4 },
        days: 7,
        radiusNm: 175,
        circle: CIRCLE_FIXTURE,
      },
    };
    expect(manifestSchema.safeParse(radius).success).toBe(true);
    expect(manifestSchema.safeParse({ ...base, subdivision: base.scope }).success).toBe(false); // strict: no 2.3 field
  });
  it("coverage: delivered needs a data version, missing has none", () => {
    expect(coverageEntry.safeParse({ id: SUBDIVISION_ID, key: "XT", name: "X", status: "missing", dataVersion: 3 }).success).toBe(false);
    expect(coverageEntry.safeParse({ id: SUBDIVISION_ID, key: "XT", name: "X", status: "delivered", dataVersion: null }).success).toBe(false);
    expect(coverageEntry.safeParse({ id: SUBDIVISION_ID, key: "XT", name: "X", status: "delivered", dataVersion: 3 }).success).toBe(true);
    expect(coverageEntry.safeParse({ id: SUBDIVISION_ID, key: "XT", name: "X", status: "missing", dataVersion: null }).success).toBe(true);
  });
  it("publishes 2.3, 3.0 and 4.0", () => {
    expect(publishedJsonSchema("2.3", "manifest.schema.json")).not.toBeNull();
    expect(publishedJsonSchema("3.0", "manifest.schema.json")).toEqual(contractJsonSchema("3.0", "manifest.schema.json"));
    expect(publishedJsonSchema("4.0", "manifest.schema.json")).toEqual(contractJsonSchema("4.0", "manifest.schema.json"));
  });

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
    ["a profile version", { profileVersion: 3 }],
    ["a validFrom", { validFrom: "2026-10-15" }],
    ["a summary", { summary: { de: "Bucht." } }],
    ["sources", { sources: [{ url: "https://example.org/a", kind: "forum", observedAt: "2025-06-10" }] }],
    ["highlight ids", { highlightIds: ["hl_01J9X4KQ3P2N1M0Z9K8J7H6G5F"] }],
    ["highlight levels", { highlightLevels: { food: "some" } }],
    ["a missing asOf", { asOf: undefined }],
    ["an asOf datetime", { asOf: "2026-10-15T00:00:00Z" }],
    ["a missing gaps list", { gaps: undefined }],
    ["an empty gap key", { gaps: [""] }],
    ["a missing facts list", { facts: undefined }],
    ["a missing landing points list", { landingPoints: undefined }],
    ["a missing nearby list", { nearby: undefined }],
    ["holding moderate (internal vocabulary)", { holding: "moderate" }],
    ["an excluded reason outside the list", { exclude: { excluded: true, reason: "firing_area", detail: null } }],
    ["month 13 in a season note", { seasonNote: [{ months: [13], text: "x" }] }],
    ["a merged spot pointing at a highlight", { mergedInto: "hl_01J9X4KQ3P2N1M0Z9K8J7H6G5F" }],
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

  it("accepts a spot with only the required fields", () => {
    const required = {
      id: ex.id,
      kind: "port",
      berthable: false,
      contact: null,
      name: "Limani",
      position: ex.position,
      shelter: ex.shelter,
      limits: ex.limits,
      exclude: { excluded: true, reason: "military", detail: "Militärisches Sperrgebiet" },
      score: { confidence: 0.2, popularity: 0, quietness: null, sourcesCount: 0, lastObserved: null },
      provenance: {},
      mergedInto: null,
      asOf: null,
      gaps: [],
      facts: [],
      landingPoints: [],
      nearby: [],
    };
    expect(spotSchema.safeParse(required).success).toBe(true);
    expect(spotSchema.safeParse(omit(required, "exclude")).success).toBe(false);
  });

  it("the contract exclusion reasons are exactly the consolidation's ExcludeReason", () => {
    expectTypeOf<NonNullable<Spot["exclude"]["reason"]>>().toEqualTypeOf<ExcludeReason>();
  });

  it("regions reject foreign ids and unknown enum values", () => {
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
    expect(SCHEMA_VERSION).toBe("4.0");
    expect(CONTRACT_FILES.map(jsonSchemaFileName)).toEqual([
      "manifest.schema.json",
      "spots.schema.json",
      "regions.schema.json",
      "coast.schema.json",
      "weather-points.schema.json",
    ]);
  });

  it.each(["1.0", "2.0", "2.1", "2.2", "2.3", "3.0", "4.0"])("checked-in JSON schemas of %s equal the generated ones", (version) => {
    for (const f of version === "4.0" ? CONTRACT_FILES : LEGACY_FILES) {
      expect(readJson(`contract/schema/${version}/${jsonSchemaFileName(f)}`), f).toEqual(
        contractJsonSchema(version, jsonSchemaFileName(f)),
      );
    }
  });

  it("2.0 names the subdivision where 1.0 named the area", () => {
    const manifest = SAMPLE_FILES["manifest.json"];
    const { scope } = manifest;
    if (scope.type !== "subdivision") throw new Error("sample is a subdivision package");
    expect(scope.subdivision).toMatchObject({ key: "GR-I" });
    expect(manifestSchema.safeParse({ ...manifest, area: scope.subdivision }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, scope: { ...scope, subdivision: { ...scope.subdivision, id: manifest.areas[0]!.id } } }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, schemaVersion: "1.0" }).success).toBe(false);
    const envelopeOnly = { ...SAMPLE_FILES["spots.json"], area: manifest.areas[0]!.id };
    expect(CONTRACT_SCHEMAS["spots.json"].safeParse(envelopeOnly).success).toBe(false);
    const regions = SAMPLE_FILES["regions.json"];
    expect(CONTRACT_SCHEMAS["regions.json"].safeParse({ ...regions, scope: { type: "subdivision", id: manifest.areas[0]!.id, dataVersion: 2 } }).success).toBe(false);
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

  it("2.2 validates highlightLevels (frozen 3.0 spot)", () => {
    const ex30 = TEIL_B_V3_0;
    const spot30 = v30.spotSchema;
    expect(spot30.safeParse({ ...ex30, highlightLevels: { culture: "many", food: "none", beach: "some" } }).success).toBe(true);
    expect(spot30.safeParse({ ...ex30, highlightLevels: {} }).success).toBe(true);
    for (const [name, highlightLevels] of [
      ["an unknown level", { food: "lots" }],
      ["an unknown category", { museums: "some" }],
      ["a list", ["some"]],
    ] as const) {
      expect(spot30.safeParse({ ...ex30, highlightLevels }).success, name).toBe(false);
    }
    // 2.1 does not know the field
    expect(JSON.stringify(contractJsonSchema("2.1", "spots.schema.json"))).not.toContain("highlightLevels");
    expect(JSON.stringify(contractJsonSchema("2.2", "spots.schema.json"))).toContain("highlightLevels");
    expect(JSON.stringify(contractJsonSchema("4.0", "spots.schema.json"))).not.toContain("highlightLevels");
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

  // the 2.2 files as published on 2026-10-22 (sha256 of the checked-in bytes): 2.3 is additive, 2.2 never changes
  const FROZEN_2_2: Record<string, string> = {
    "changes.schema.json": "8b29c4688284e7dbac10ef2b17d01473d7c1fe0deacd1b730e9635f5f033a3e2",
    "coast.schema.json": "0f3f14def652befbde09c3c7542aa22f4de9497cb26646c6f88e8b15baeb8dcf",
    "highlights.schema.json": "8b4bbfa76d9eb0915e0c67109d276fa8089ba762dd5a1a249dbbe8a4f5e6c41c",
    "manifest.schema.json": "78d876c90ae0fa2e80715b0125178b4655fee0c470f0bf66c5bd96201463b204",
    "regions.schema.json": "571088c5166f38882a54f63669ca6b5a56b8eb3ee6d27d9472e0923027830970",
    "spots.schema.json": "8c1f96553beefe97a1a76dffe123aa5e8b6760160e3561d183108a4a65d45e8d",
    "weather-points.schema.json": "ead00fd4e22cb3a7297496f92a0e4ae5c379acdb450f28d7fb561b59c0bd76a7",
  };

  it("2.2 schema files are unchanged", () => {
    expect(readdirSync("contract/schema/2.2").sort()).toEqual(Object.keys(FROZEN_2_2).sort());
    for (const [file, sha] of Object.entries(FROZEN_2_2)) {
      expect(createHash("sha256").update(readFileSync(`contract/schema/2.2/${file}`)).digest("hex"), file).toBe(sha);
      expect(publishedJsonSchema("2.2", file), file).toEqual(readJson(`contract/schema/2.2/${file}`));
    }
    // 2.1 and 2.2 know neither berthable nor contact
    expect(JSON.stringify(contractJsonSchema("2.1", "spots.schema.json"))).not.toContain("berthable");
    expect(JSON.stringify(contractJsonSchema("2.2", "spots.schema.json"))).not.toContain("berthable");
    expect(JSON.stringify(contractJsonSchema("2.3", "spots.schema.json"))).toContain("berthable");
  });

  it("2.3 spot carries berthable and contact (each nullable, required)", () => {
    expect(spotSchema.safeParse(ex).success).toBe(true);
    expect(spotSchema.safeParse({ ...ex, berthable: null, contact: null }).success).toBe(true);
    expect(spotSchema.safeParse({ ...ex, berthable: false, contact: { vhf: null, phone: null, url: null } }).success).toBe(true);
    expect(spotSchema.safeParse(omit(ex, "berthable")).success).toBe(false);
    expect(spotSchema.safeParse(omit(ex, "contact")).success).toBe(false);
    expect(spotSchema.safeParse({ ...ex, contact: { vhf: "71", phone: null, url: "not a url" } }).success).toBe(false);
    for (const url of ["javascript:alert(1)", "ftp://marina.example", "upload://doc"]) {
      expect(spotSchema.safeParse({ ...ex, contact: { vhf: null, phone: null, url } }).success, url).toBe(false);
    }
    expect(JSON.stringify(contractJsonSchema("2.3", "spots.schema.json"))).toContain("^https?://");
    expect(spotSchema.safeParse({ ...ex, contact: { vhf: "71", phone: null, url: null, extra: 1 } }).success).toBe(false);
  });

  it("a generated JSON schema carries its id and title", () => {
    expect(contractJsonSchema("4.0", "spots.schema.json")).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "periplus:contract/4.0/spots.schema.json",
      title: "Periplus Data Contract 4.0 – spots.json",
    });
    expect(contractJsonSchema("3.0", "highlights.schema.json")).toMatchObject({ title: "Periplus Data Contract 3.0 – highlights.json" });
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
    for (const [version, file] of [["5.0", "spots.schema.json"], ["2.0", "spots.json"], ["1.0", "spots.json"], ["1.0", "constructor"], ["__proto__", "spots.schema.json"]]) {
      expect(publishedJsonSchema(version!, file!), `${version}/${file}`).toBeNull();
    }
  });

  it("an unknown version or file yields null", () => {
    expect(contractJsonSchema("5.0", "spots.schema.json")).toBeNull();
    expect(contractJsonSchema("4.0", "highlights.schema.json")).toBeNull();
    expect(contractJsonSchema("4.0", "changes.schema.json")).toBeNull();
    expect(contractJsonSchema("2.0", "spots.json")).toBeNull();
    expect(contractJsonSchema("1.0", "../package.json")).toBeNull();
    expect(contractJsonSchema("__proto__", "spots.schema.json")).toBeNull();
  });
  // the 3.0 files as published (sha256 of the checked-in bytes): 4.0 is a new major version, 3.0 never changes
  const FROZEN_3_0: Record<string, string> = {
    "changes.schema.json": "c93cbf96b8ab7a60dabe7fc374b992237fd42df9081cc1f7c311e695b5fb3dae",
    "coast.schema.json": "315aea22a9a43f6007c2bb71b2d169d67a17516f842f661f912163edbc2f089d",
    "highlights.schema.json": "fe8cf8378f6c354e52c3df18d0373e00553964c80e46ebeb44836b4d41d7b1d5",
    "manifest.schema.json": "952cc95d6e48384ce01827099d45cd85ec303e64a1ebed811353c4cc5692f525",
    "regions.schema.json": "8e6c148ffcefcc91ce117727e0bbf9642a0fd5d8da97b50b6de469df67361239",
    "spots.schema.json": "6b6c6c51626815a84d27bc47fa83b09ade0d8df61bed1c89fd723fb7d808dcb2",
    "weather-points.schema.json": "94714c0dc27522f3d6e2d79fb023f35b0ef06db7007fca3b9657d416a7938541",
  };

  it("3.0 schema files are unchanged and its frozen copy still validates a 3.0 package", () => {
    expect(readdirSync("contract/schema/3.0").sort()).toEqual(Object.keys(FROZEN_3_0).sort());
    for (const [file, sha] of Object.entries(FROZEN_3_0)) {
      expect(createHash("sha256").update(readFileSync(`contract/schema/3.0/${file}`)).digest("hex"), file).toBe(sha);
      expect(publishedJsonSchema("3.0", file), file).toEqual(readJson(`contract/schema/3.0/${file}`));
    }
    for (const file of v30.CONTRACT_FILES) {
      const result = SCHEMAS_3_0[file].safeParse(SAMPLE_FILES_V3_0[file]);
      expect(result.error?.issues, file).toBeUndefined();
    }
    // 4.0 does not know what 3.0 carried
    expect(spotSchema.safeParse(TEIL_B_V3_0).success).toBe(false);
    expect(v30.spotSchema.safeParse(ex).success).toBe(false);
  });

  it("4.0 spot carries facts, landing points and things on land", () => {
    const parsed = spotSchema.parse(ex);
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.asOf).toBe("2026-10-15");
    expect(spotSchema.safeParse({ ...ex, asOf: null, gaps: [], facts: [], landingPoints: [], nearby: [] }).success).toBe(true);
  });

  it("a fact needs an fc_ id; a landside subject needs an id or a name", () => {
    const fact = ex.facts[0]!;
    expect(factSchema.safeParse(fact).success).toBe(true);
    expect(factSchema.safeParse({ ...fact, id: "hl_01J9X4P0A1B2C3D4E5F6G7H8J9" }).success).toBe(false);
    expect(factSchema.safeParse({ ...fact, text: "" }).success).toBe(false);
    expect(factSchema.safeParse({ ...fact, tone: "good" }).success).toBe(false);
    expect(factSchema.safeParse({ ...fact, tone: null, observedAt: null }).success).toBe(true);
    expect(factSchema.safeParse({ ...fact, mentions: -1 }).success).toBe(false);
    expect(factSchema.safeParse({ ...fact, sources: [] }).success).toBe(false);
    const landside = (id: string | null, name: string | null) => ({ ...fact, subject: { kind: "landside", id, name } });
    expect(factSchema.safeParse(landside("hl_01J9X4KQ3P2N1M0Z9K8J7H6G5F", "Taverna")).success).toBe(true);
    expect(factSchema.safeParse(landside(null, "Taverna ohne Id")).success).toBe(true);
    expect(factSchema.safeParse(landside("hl_01J9X4KQ3P2N1M0Z9K8J7H6G5F", null)).success).toBe(true);
    expect(factSchema.safeParse(landside(null, null)).success).toBe(false);
    expect(factSchema.safeParse(landside("sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z1", "x")).success).toBe(false);
    expect(factSchema.safeParse({ ...fact, subject: { kind: "spot", id: null } }).success).toBe(false);
  });

  it("landing points are a kind with a position or a text", () => {
    const point = { lat: 37.6079, lon: 23.3392 };
    for (const kind of ["harbour", "pier", "slipway", "beach", "shore"]) {
      expect(spotSchema.safeParse({ ...ex, landingPoints: [{ kind, position: point }] }).success, kind).toBe(true);
    }
    for (const [name, landingPoints] of [
      ["an unknown kind", [{ kind: "cliff", position: point }]],
      ["text with a position", [{ kind: "text", description: "x", position: point }]],
      ["text without a description", [{ kind: "text" }]],
      ["an empty description", [{ kind: "text", description: "" }]],
      ["a kind without a position", [{ kind: "beach" }]],
    ] as const) {
      expect(spotSchema.safeParse({ ...ex, landingPoints }, ).success, name).toBe(false);
    }
  });

  it("nearby entries reference hl_ ids with a category, a distance and an access", () => {
    const entry = ex.nearby[0]!;
    expect(spotSchema.safeParse({ ...ex, nearby: [entry] }).success).toBe(true);
    expect(spotSchema.safeParse({ ...ex, nearby: [{ ...entry, names: [{ lang: "el", name: "Ταβέρνα", script: "greek" }] }] }).success).toBe(true);
    for (const category of ["bakery", "transport", "supply", "quiet"]) {
      expect(spotSchema.safeParse({ ...ex, nearby: [{ ...entry, category }] }).success, category).toBe(true);
    }
    for (const [name, patch] of [
      ["an sp_ id", { id: "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z1" }],
      ["a landing category", { category: "landing" }],
      ["an unknown category", { category: "anchorage" }],
      ["an unknown access", { access: "car" }],
      ["a negative distance", { distanceM: -1 }],
      ["an empty name", { name: "" }],
      ["a fractional distance", { distanceM: 12.5 }],
    ] as const) {
      expect(spotSchema.safeParse({ ...ex, nearby: [{ ...entry, ...patch }] }).success, name).toBe(false);
    }
    expect(nearbyCategory.options).toEqual(["food", "supply", "beach", "nature", "active", "culture", "town", "quiet", "bakery", "transport"]);
  });

  it("4.0 manifest and files carry states, no highlights and no changes", () => {
    const manifest = SAMPLE_FILES["manifest.json"];
    expect(manifest.tiles[0]).toHaveProperty("statesAsOf");
    expect(manifestSchema.safeParse({ ...manifest, tiles: [{ ...manifest.tiles[0]!, profilesAsOf: "2026-10-18" }] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, objectCounts: { ...manifest.objectCounts, highlights: 1 } }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, objectCounts: { ...manifest.objectCounts, changes: 0 } }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, schemaVersion: "3.0" }).success).toBe(false);
    const files = (name: string) => manifest.files.map((f) => ({ ...f, name }));
    expect(manifestSchema.safeParse({ ...manifest, files: files("highlights.json") }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, files: files("changes.json") }).success).toBe(false);
    expect(CONTRACT_FILES).toEqual(["manifest.json", "spots.json", "regions.json", "coast.geojson", "weather-points.json"]);
    expect(CONTRACT_SCHEMAS["spots.json"].safeParse({ ...SAMPLE_FILES["spots.json"], schemaVersion: "3.0" }).success).toBe(false);
  });

  it("the changes response is the fixed reload answer", () => {
    expect(changesResponseSchema.safeParse({ invalidSince: true, reason: "reload" }).success).toBe(true);
    for (const bad of [{}, { invalidSince: false, reason: "reload" }, { invalidSince: true, reason: "other" }, { invalidSince: true, reason: "reload", changes: [] }]) {
      expect(changesResponseSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("SpotBody is a spot without asOf", () => {
    expectTypeOf<SpotBody>().toEqualTypeOf<Omit<Spot, "asOf">>();
  });
});
