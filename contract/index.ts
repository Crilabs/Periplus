import { z } from "zod";
import * as v1 from "./v1";
import * as v2 from "./v2_0";
import * as v21 from "./v2_1";
import * as v22 from "./v2_2";
import * as v23 from "./v2_3";
import {
  changesFileSchema,
  coastCollectionSchema,
  CONTRACT_FILES,
  highlightsFileSchema,
  IMAGE_FILE_PATTERN,
  manifestSchema,
  regionsFileSchema,
  spotsFileSchema,
  weatherPointsFileSchema,
  type ContractFile,
} from "./v2";

/*
 * Periplus Data Contract (spec 08, spec 14, spec 13). The zod schemas in `contract/v2/` are the source of the current version;
 * the JSON schemas under `contract/schema/<version>/` are generated from them (`npm run contract:generate`); every
 * checked-in version is served by `GET /api/v2/schema/<version>/<file>` (and `/api/v1/schema/…`) from `contract/schema/published.ts`. Versions
 * 1.0 (packages per configured area, `contract/v1/`), 2.0 (before the images, `contract/v2_0/`), 2.1 (before the
 * highlight levels, `contract/v2_1/`) and 2.2 (before berthable and contact, `contract/v2_2/`) stay reproducible from
 * their frozen copies and stay published; 2.1 adds `images` and image files to 2.0, 2.2 adds `spot.highlightLevels` to
 * 2.1 (spec 16), 2.3 adds `spot.berthable` and `spot.contact` to 2.2 (spec 17; all minor, additive). Version 2.3
 * (before the scope, `contract/v2_3/`) is frozen the same way. 3.0 adds `scope` and `coverage` (spec 18; major: the
 * manifest loses `subdivision`, `dataVersion` and `previousDataVersion`, the file envelope loses `subdivision` and `dataVersion`).
 */

export const SCHEMA_VERSION = "3.0";
export { CONTRACT_FILES, IMAGE_FILE_PATTERN };
export type { ContractFile };
export type {
  ChangeEntry,
  ChangesFile,
  CoastCollection,
  CoastFeature,
  Highlight,
  HighlightBody,
  PlaceImage,
  HighlightsFile,
  CoverageEntry,
  FileScope,
  Manifest,
  ManifestScope,
  Region,
  RegionBody,
  RegionsFile,
  Spot,
  SpotBody,
  SpotsFile,
  WeatherPoint,
  WeatherPointsFile,
} from "./v2";

export const CONTRACT_SCHEMAS: Record<ContractFile, z.ZodType> = {
  "manifest.json": manifestSchema,
  "spots.json": spotsFileSchema,
  "highlights.json": highlightsFileSchema,
  "regions.json": regionsFileSchema,
  "coast.geojson": coastCollectionSchema,
  "weather-points.json": weatherPointsFileSchema,
  "changes.json": changesFileSchema,
};

/** The zod schemas of the superseded version 1.0, kept to pin its published JSON schemas. */
const CONTRACT_SCHEMAS_V1: Record<ContractFile, z.ZodType> = {
  "manifest.json": v1.manifestSchema,
  "spots.json": v1.spotsFileSchema,
  "highlights.json": v1.highlightsFileSchema,
  "regions.json": v1.regionsFileSchema,
  "coast.geojson": v1.coastCollectionSchema,
  "weather-points.json": v1.weatherPointsFileSchema,
  "changes.json": v1.changesFileSchema,
};

/** The zod schemas of the superseded version 2.0, kept to pin its published JSON schemas. */
const CONTRACT_SCHEMAS_V2_0: Record<ContractFile, z.ZodType> = {
  "manifest.json": v2.manifestSchema,
  "spots.json": v2.spotsFileSchema,
  "highlights.json": v2.highlightsFileSchema,
  "regions.json": v2.regionsFileSchema,
  "coast.geojson": v2.coastCollectionSchema,
  "weather-points.json": v2.weatherPointsFileSchema,
  "changes.json": v2.changesFileSchema,
};

/** The zod schemas of the superseded version 2.1, kept to pin its published JSON schemas. */
const CONTRACT_SCHEMAS_V2_1: Record<ContractFile, z.ZodType> = {
  "manifest.json": v21.manifestSchema,
  "spots.json": v21.spotsFileSchema,
  "highlights.json": v21.highlightsFileSchema,
  "regions.json": v21.regionsFileSchema,
  "coast.geojson": v21.coastCollectionSchema,
  "weather-points.json": v21.weatherPointsFileSchema,
  "changes.json": v21.changesFileSchema,
};

/** The zod schemas of the superseded version 2.2, kept to pin its published JSON schemas. */
const CONTRACT_SCHEMAS_V2_2: Record<ContractFile, z.ZodType> = {
  "manifest.json": v22.manifestSchema,
  "spots.json": v22.spotsFileSchema,
  "highlights.json": v22.highlightsFileSchema,
  "regions.json": v22.regionsFileSchema,
  "coast.geojson": v22.coastCollectionSchema,
  "weather-points.json": v22.weatherPointsFileSchema,
  "changes.json": v22.changesFileSchema,
};

/** The zod schemas of the superseded version 2.3, kept to pin its published JSON schemas. */
const CONTRACT_SCHEMAS_V2_3: Record<ContractFile, z.ZodType> = {
  "manifest.json": v23.manifestSchema,
  "spots.json": v23.spotsFileSchema,
  "highlights.json": v23.highlightsFileSchema,
  "regions.json": v23.regionsFileSchema,
  "coast.geojson": v23.coastCollectionSchema,
  "weather-points.json": v23.weatherPointsFileSchema,
  "changes.json": v23.changesFileSchema,
};

const SCHEMAS_BY_VERSION: Readonly<Record<string, Record<ContractFile, z.ZodType>>> = {
  "1.0": CONTRACT_SCHEMAS_V1,
  "2.0": CONTRACT_SCHEMAS_V2_0,
  "2.1": CONTRACT_SCHEMAS_V2_1,
  "2.2": CONTRACT_SCHEMAS_V2_2,
  "2.3": CONTRACT_SCHEMAS_V2_3,
  [SCHEMA_VERSION]: CONTRACT_SCHEMAS,
};

/** `spots.json` → `spots.schema.json`, `coast.geojson` → `coast.schema.json`. */
export function jsonSchemaFileName(file: ContractFile): string {
  return `${file.replace(/\.(json|geojson)$/, "")}.schema.json`;
}

const FILE_BY_SCHEMA_NAME = new Map<string, ContractFile>(CONTRACT_FILES.map((f) => [jsonSchemaFileName(f), f]));

/** The JSON schema (draft 2020-12) of a contract file, e.g. ("3.0", "spots.schema.json"); null for anything else. */
export function contractJsonSchema(version: string, fileName: string): object | null {
  if (!Object.hasOwn(SCHEMAS_BY_VERSION, version)) return null;
  const file = FILE_BY_SCHEMA_NAME.get(fileName);
  if (!file) return null;
  const generated = z.toJSONSchema(SCHEMAS_BY_VERSION[version]![file], { target: "draft-2020-12" });
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: `periplus:contract/${version}/${fileName}`,
    title: `Periplus Data Contract ${version} – ${file}`,
    ...rest,
  };
}
