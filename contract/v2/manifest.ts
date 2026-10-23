import { z } from "zod";
import { imageFile } from "./image";
import {
  areal,
  CONTRACT_FILES,
  count,
  geoPolygon,
  httpUrl,
  isoDate,
  isoDateTime,
  latitude,
  latLon,
  longitude,
  publicId,
  radiusKey,
} from "./common";

/** A subdivision (Landesteil) as the manifest describes it. */
export const subdivisionRef = z.strictObject({
  id: publicId("sd"),
  key: z.string().min(1),
  name: z.string().min(1),
  names: z.array(z.strictObject({ lang: z.string().min(2), name: z.string().min(1) })),
  polygon: areal,
});

/** Which subdivisions a package covers and at which data version; `delivered` has a version, `missing` has none. */
export const coverageEntry = z
  .strictObject({
    id: publicId("sd"),
    key: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(["delivered", "missing"]),
    dataVersion: z.number().int().min(1).nullable(),
  })
  .refine((c) => (c.status === "delivered") === (c.dataVersion !== null), {
    message: "delivered needs a dataVersion, missing has none",
    path: ["dataVersion"],
  });

/** What the package is: one subdivision, or the radius around a home marina (spec 18). */
export const manifestScope = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("subdivision"),
    subdivision: subdivisionRef,
    dataVersion: z.number().int().min(1),
    previousDataVersion: z.number().int().min(1).nullable(),
  }),
  z.strictObject({
    type: z.literal("radius"),
    key: radiusKey,
    homeMarina: z.strictObject({ id: publicId("sp"), name: z.string().min(1) }),
    center: latLon,
    days: z.number().int().min(1).max(28),
    radiusNm: z.number().positive(),
    circle: geoPolygon,
  }),
]);

/** `manifest.json`: what the package is (`scope`), which subdivisions it covers, with which files and licences. */
export const manifestSchema = z.strictObject({
  schemaVersion: z.literal("3.0"),
  scope: manifestScope,
  coverage: z.array(coverageEntry).min(1),
  /** The sailing areas (Reviere) that touch the subdivision's tiles; for information only. */
  areas: z.array(
    z.strictObject({
      id: publicId("ar"),
      key: z.string().min(1),
      names: z.array(z.strictObject({ lang: z.string().min(2), name: z.string().min(1) })),
    }),
  ),
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
    z.strictObject({ name: z.union([z.enum(CONTRACT_FILES), imageFile]), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: count }),
  ),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestScope = z.infer<typeof manifestScope>;
export type CoverageEntry = z.infer<typeof coverageEntry>;
