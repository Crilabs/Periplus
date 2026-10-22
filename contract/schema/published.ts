import changes10 from "./1.0/changes.schema.json";
import coast10 from "./1.0/coast.schema.json";
import highlights10 from "./1.0/highlights.schema.json";
import manifest10 from "./1.0/manifest.schema.json";
import regions10 from "./1.0/regions.schema.json";
import spots10 from "./1.0/spots.schema.json";
import weatherPoints10 from "./1.0/weather-points.schema.json";
import changes23 from "./2.3/changes.schema.json";
import coast23 from "./2.3/coast.schema.json";
import highlights23 from "./2.3/highlights.schema.json";
import manifest23 from "./2.3/manifest.schema.json";
import regions23 from "./2.3/regions.schema.json";
import spots23 from "./2.3/spots.schema.json";
import weatherPoints23 from "./2.3/weather-points.schema.json";
import changes22 from "./2.2/changes.schema.json";
import coast22 from "./2.2/coast.schema.json";
import highlights22 from "./2.2/highlights.schema.json";
import manifest22 from "./2.2/manifest.schema.json";
import regions22 from "./2.2/regions.schema.json";
import spots22 from "./2.2/spots.schema.json";
import weatherPoints22 from "./2.2/weather-points.schema.json";
import changes21 from "./2.1/changes.schema.json";
import coast21 from "./2.1/coast.schema.json";
import highlights21 from "./2.1/highlights.schema.json";
import manifest21 from "./2.1/manifest.schema.json";
import regions21 from "./2.1/regions.schema.json";
import spots21 from "./2.1/spots.schema.json";
import weatherPoints21 from "./2.1/weather-points.schema.json";
import changes20 from "./2.0/changes.schema.json";
import coast20 from "./2.0/coast.schema.json";
import highlights20 from "./2.0/highlights.schema.json";
import manifest20 from "./2.0/manifest.schema.json";
import regions20 from "./2.0/regions.schema.json";
import spots20 from "./2.0/spots.schema.json";
import weatherPoints20 from "./2.0/weather-points.schema.json";

/*
 * The checked-in JSON schemas of every published contract version (spec 08: `contract/schema/<version>/`), served by
 * `GET /api/v2/schema/<version>/<file>` (and `/api/v1/schema/…`). A new version adds its directory and an entry here; older versions stay, so a
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
  "2.0": {
    "manifest.schema.json": manifest20,
    "spots.schema.json": spots20,
    "highlights.schema.json": highlights20,
    "regions.schema.json": regions20,
    "coast.schema.json": coast20,
    "weather-points.schema.json": weatherPoints20,
    "changes.schema.json": changes20,
  },
  "2.1": {
    "manifest.schema.json": manifest21,
    "spots.schema.json": spots21,
    "highlights.schema.json": highlights21,
    "regions.schema.json": regions21,
    "coast.schema.json": coast21,
    "weather-points.schema.json": weatherPoints21,
    "changes.schema.json": changes21,
  },
  "2.2": {
    "manifest.schema.json": manifest22,
    "spots.schema.json": spots22,
    "highlights.schema.json": highlights22,
    "regions.schema.json": regions22,
    "coast.schema.json": coast22,
    "weather-points.schema.json": weatherPoints22,
    "changes.schema.json": changes22,
  },
  "2.3": {
    "manifest.schema.json": manifest23,
    "spots.schema.json": spots23,
    "highlights.schema.json": highlights23,
    "regions.schema.json": regions23,
    "coast.schema.json": coast23,
    "weather-points.schema.json": weatherPoints23,
    "changes.schema.json": changes23,
  },
};

/** The published JSON schema of `fileName` in contract `version`; null for an unknown version or file. */
export function publishedJsonSchema(version: string, fileName: string): object | null {
  if (!Object.hasOwn(PUBLISHED_SCHEMAS, version)) return null;
  const files = PUBLISHED_SCHEMAS[version]!;
  return Object.hasOwn(files, fileName) ? files[fileName]! : null;
}
