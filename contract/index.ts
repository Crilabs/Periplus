import { z } from "zod";
import * as v1 from "./v1";
import {
  changesFileSchema,
  coastCollectionSchema,
  CONTRACT_FILES,
  highlightsFileSchema,
  manifestSchema,
  regionsFileSchema,
  spotsFileSchema,
  weatherPointsFileSchema,
  type ContractFile,
} from "./v2";

/*
 * Periplus Data Contract (spec 08, spec 14). The zod schemas in `contract/v2/` are the source of the current version;
 * the JSON schemas under `contract/schema/<version>/` are generated from them (`npm run contract:generate`); every
 * checked-in version is served by `GET /api/v2/schema/<version>/<file>` (and `/api/v1/schema/…`) from `contract/schema/published.ts`. Version
 * 1.0 (packages per configured area) stays reproducible from `contract/v1/` and stays published.
 */

export const SCHEMA_VERSION = "2.0";
export { CONTRACT_FILES };
export type { ContractFile };
export type {
  ChangeEntry,
  ChangesFile,
  CoastCollection,
  CoastFeature,
  Highlight,
  HighlightBody,
  HighlightsFile,
  Manifest,
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

const SCHEMAS_BY_VERSION: Readonly<Record<string, Record<ContractFile, z.ZodType>>> = {
  "1.0": CONTRACT_SCHEMAS_V1,
  [SCHEMA_VERSION]: CONTRACT_SCHEMAS,
};

/** `spots.json` → `spots.schema.json`, `coast.geojson` → `coast.schema.json`. */
export function jsonSchemaFileName(file: ContractFile): string {
  return `${file.replace(/\.(json|geojson)$/, "")}.schema.json`;
}

const FILE_BY_SCHEMA_NAME = new Map<string, ContractFile>(CONTRACT_FILES.map((f) => [jsonSchemaFileName(f), f]));

/** The JSON schema (draft 2020-12) of a contract file, e.g. ("2.0", "spots.schema.json"); null for anything else. */
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
