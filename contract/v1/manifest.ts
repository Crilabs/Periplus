import { z } from "zod";
import { areal, CONTRACT_FILES, count, httpUrl, isoDate, isoDateTime, latitude, longitude, publicId } from "./common";

/** `manifest.json`: what the package is, for which area, with which files and licences. */
export const manifestSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  area: z.strictObject({
    id: publicId("ar"),
    key: z.string().min(1),
    name: z.string().min(1),
    names: z.array(z.strictObject({ lang: z.string().min(2), name: z.string().min(1) })),
    polygon: areal,
  }),
  dataVersion: z.number().int().min(1),
  previousDataVersion: z.number().int().min(1).nullable(),
  generatedAt: isoDateTime,
  /** `[west, south, east, north]`. */
  bbox: z.tuple([longitude, latitude, longitude, latitude]),
  tiles: z.array(
    z.strictObject({
      id: z.string().regex(/^q025:\d+:\d+$/),
      lastRunAt: isoDateTime.nullable(),
      profilesAsOf: isoDate.nullable(),
    }),
  ),
  objectCounts: z.strictObject({
    spots: count,
    highlights: count,
    regions: count,
    weatherPoints: count,
    coastFeatures: count,
    changes: count,
  }),
  licenses: z.array(
    z.strictObject({
      name: z.string().min(1),
      attribution: z.string().min(1),
      url: httpUrl,
      files: z.array(z.enum(CONTRACT_FILES)),
      // JSON pointers with `*` for every list entry, e.g. `spots.json#/spots/*/name`.
      fields: z.array(z.string().min(1)),
    }),
  ),
  files: z.array(
    z.strictObject({ name: z.enum(CONTRACT_FILES), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: count }),
  ),
});

export type Manifest = z.infer<typeof manifestSchema>;
