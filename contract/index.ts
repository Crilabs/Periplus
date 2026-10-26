import { z } from "zod";
import * as v30 from "./v3_0";
import {
  coastCollectionSchema,
  CONTRACT_FILES,
  IMAGE_FILE_PATTERN,
  manifestSchema,
  regionsFileSchema,
  spotsFileSchema,
  weatherPointsFileSchema,
  type ContractFile,
} from "./v2";

/*
 * Periplus Data Contract (spec 08, spec 14, spec 13). The zod schemas in `contract/v2/` are the source of the current version
 * (4.0; the directory name is historic); the JSON schemas under `contract/schema/<version>/` are generated from them
 * (`npm run contract:generate`); every checked-in version is served by `GET /api/v4/schema/<version>/<file>` from
 * `contract/schema/published.ts`. Version 3.0 (before the new orientation,
 * `contract/v3_0/`) stays reproducible from its frozen copy and published (N5); it added `scope` and `coverage` (spec 18;
 * major: the manifest lost `subdivision`, `dataVersion` and `previousDataVersion`, the file envelope lost `subdivision`
 * and `dataVersion`). Versions 1.0 to 2.3 were removed with the old pipeline (N6). 4.0 is built
 * from berth states (new orientation, major): spots carry free facts, landing points and the things reachable on land
 * (`nearby`), `asOf` and `gaps`; sources, summaries, highlights (`highlights.json`, `highlightIds`, `highlightLevels`),
 * version fields on the spot and the change feed (`changes.json`) are gone, the manifest tile reads `statesAsOf`.
 */

export const SCHEMA_VERSION = "4.0";
export { CONTRACT_FILES, IMAGE_FILE_PATTERN };
export type { ContractFile };
export type {
  ChangesResponse,
  CoastCollection,
  CoastFeature,
  CoverageEntry,
  Fact,
  FileScope,
  LandingPoint,
  NearbyEntry,
  PlaceImage,
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

export { changesResponseSchema } from "./v2";

export const CONTRACT_SCHEMAS: Record<ContractFile, z.ZodType> = {
  "manifest.json": manifestSchema,
  "spots.json": spotsFileSchema,
  "regions.json": regionsFileSchema,
  "coast.geojson": coastCollectionSchema,
  "weather-points.json": weatherPointsFileSchema,
};

/** The zod schemas of the superseded version 3.0, kept to pin its published JSON schemas. */
const CONTRACT_SCHEMAS_V3_0: Record<v30.ContractFile, z.ZodType> = {
  "manifest.json": v30.manifestSchema,
  "spots.json": v30.spotsFileSchema,
  "highlights.json": v30.highlightsFileSchema,
  "regions.json": v30.regionsFileSchema,
  "coast.geojson": v30.coastCollectionSchema,
  "weather-points.json": v30.weatherPointsFileSchema,
  "changes.json": v30.changesFileSchema,
};

const SCHEMAS_BY_VERSION: Readonly<Record<string, Readonly<Record<string, z.ZodType>>>> = {
  "3.0": CONTRACT_SCHEMAS_V3_0,
  [SCHEMA_VERSION]: CONTRACT_SCHEMAS,
};

/** `spots.json` → `spots.schema.json`, `coast.geojson` → `coast.schema.json`. */
export function jsonSchemaFileName(file: string): string {
  return `${file.replace(/\.(json|geojson)$/, "")}.schema.json`;
}

/** The JSON schema (draft 2020-12) of a contract file, e.g. ("4.0", "spots.schema.json"); null for anything else. */
export function contractJsonSchema(version: string, fileName: string): object | null {
  if (!Object.hasOwn(SCHEMAS_BY_VERSION, version)) return null;
  const schemas = SCHEMAS_BY_VERSION[version]!;
  const file = Object.keys(schemas).find((f) => jsonSchemaFileName(f) === fileName);
  if (!file) return null;
  const generated = z.toJSONSchema(schemas[file]!, { target: "draft-2020-12" });
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: `periplus:contract/${version}/${fileName}`,
    title: `Periplus Data Contract ${version} – ${file}`,
    ...rest,
  };
}
