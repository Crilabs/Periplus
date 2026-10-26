import coast40 from "./4.0/coast.schema.json";
import manifest40 from "./4.0/manifest.schema.json";
import regions40 from "./4.0/regions.schema.json";
import spots40 from "./4.0/spots.schema.json";
import weatherPoints40 from "./4.0/weather-points.schema.json";
import changes30 from "./3.0/changes.schema.json";
import coast30 from "./3.0/coast.schema.json";
import highlights30 from "./3.0/highlights.schema.json";
import manifest30 from "./3.0/manifest.schema.json";
import regions30 from "./3.0/regions.schema.json";
import spots30 from "./3.0/spots.schema.json";
import weatherPoints30 from "./3.0/weather-points.schema.json";

/*
 * The checked-in JSON schemas of every published contract version (spec 08: `contract/schema/<version>/`), served by
 * `GET /api/v4/schema/<version>/<file>`. A new version adds its directory and an entry here; older versions stay, so a
 * consumer of an archived package (`?dataVersion=`) can still fetch the schema it was built against (gesamt-review
 * DAT-9). The contract test pins the current version to the zod-generated output and this registry to the files.
 */
export const PUBLISHED_SCHEMAS: Readonly<Record<string, Readonly<Record<string, object>>>> = {
  "3.0": {
    "manifest.schema.json": manifest30,
    "spots.schema.json": spots30,
    "highlights.schema.json": highlights30,
    "regions.schema.json": regions30,
    "coast.schema.json": coast30,
    "weather-points.schema.json": weatherPoints30,
    "changes.schema.json": changes30,
  },
  "4.0": {
    "manifest.schema.json": manifest40,
    "spots.schema.json": spots40,
    "regions.schema.json": regions40,
    "coast.schema.json": coast40,
    "weather-points.schema.json": weatherPoints40,
  },
};

/** The published JSON schema of `fileName` in contract `version`; null for an unknown version or file. */
export function publishedJsonSchema(version: string, fileName: string): object | null {
  if (!Object.hasOwn(PUBLISHED_SCHEMAS, version)) return null;
  const files = PUBLISHED_SCHEMAS[version]!;
  return Object.hasOwn(files, fileName) ? files[fileName]! : null;
}
