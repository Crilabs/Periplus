import changes10 from "./1.0/changes.schema.json";
import coast10 from "./1.0/coast.schema.json";
import highlights10 from "./1.0/highlights.schema.json";
import manifest10 from "./1.0/manifest.schema.json";
import regions10 from "./1.0/regions.schema.json";
import spots10 from "./1.0/spots.schema.json";
import weatherPoints10 from "./1.0/weather-points.schema.json";

/*
 * The checked-in JSON schemas of every published contract version (spec 08: `contract/schema/<version>/`), served by
 * `GET /api/v1/schema/<version>/<file>`. A new version adds its directory and an entry here; older versions stay, so a
 * consumer of an archived package (`?dataVersion=`) can still fetch the schema it was built against (gesamt-review
 * DAT-9). The contract test pins the current version to the zod-generated output and this registry to the files.
 */
export const PUBLISHED_SCHEMAS: Readonly<Record<string, Readonly<Record<string, object>>>> = {
  "1.0": {
    "manifest.schema.json": manifest10,
    "spots.schema.json": spots10,
    "highlights.schema.json": highlights10,
    "regions.schema.json": regions10,
    "coast.schema.json": coast10,
    "weather-points.schema.json": weatherPoints10,
    "changes.schema.json": changes10,
  },
};

/** The published JSON schema of `fileName` in contract `version`; null for an unknown version or file. */
export function publishedJsonSchema(version: string, fileName: string): object | null {
  if (!Object.hasOwn(PUBLISHED_SCHEMAS, version)) return null;
  const files = PUBLISHED_SCHEMAS[version]!;
  return Object.hasOwn(files, fileName) ? files[fileName]! : null;
}
