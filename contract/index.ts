import { z } from "zod";
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
} from "./v1";

/*
 * Periplus Data Contract (spec 08). The zod schemas in `contract/v1/` are the source; the JSON schemas under
 * `contract/schema/<version>/` are generated from them (`npm run contract:generate`); every checked-in version is
 * served by `GET /api/v1/schema/<version>/<file>` from `contract/schema/published.ts`.
 */

export const SCHEMA_VERSION = "1.0";
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
} from "./v1";

export const CONTRACT_SCHEMAS: Record<ContractFile, z.ZodType> = {
  "manifest.json": manifestSchema,
  "spots.json": spotsFileSchema,
  "highlights.json": highlightsFileSchema,
  "regions.json": regionsFileSchema,
  "coast.geojson": coastCollectionSchema,
  "weather-points.json": weatherPointsFileSchema,
  "changes.json": changesFileSchema,
};

/** `spots.json` → `spots.schema.json`, `coast.geojson` → `coast.schema.json`. */
export function jsonSchemaFileName(file: ContractFile): string {
  return `${file.replace(/\.(json|geojson)$/, "")}.schema.json`;
}

const FILE_BY_SCHEMA_NAME = new Map<string, ContractFile>(CONTRACT_FILES.map((f) => [jsonSchemaFileName(f), f]));

/** The JSON schema (draft 2020-12) of a contract file, e.g. ("1.0", "spots.schema.json"); null for anything else. */
export function contractJsonSchema(version: string, fileName: string): object | null {
  if (version !== SCHEMA_VERSION) return null;
  const file = FILE_BY_SCHEMA_NAME.get(fileName);
  if (!file) return null;
  const generated = z.toJSONSchema(CONTRACT_SCHEMAS[file], { target: "draft-2020-12" });
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: `periplus:contract/${version}/${fileName}`,
    title: `Periplus Data Contract ${version} – ${file}`,
    ...rest,
  };
}
