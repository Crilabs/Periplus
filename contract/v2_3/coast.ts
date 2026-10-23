import { z } from "zod";
import { geoLineString, geoMultiLineString, geoMultiPolygon, geoPolygon, isoDate } from "./common";

/**
 * `coast.geojson`: land polygons and coastline of the area box plus margin (OSM, ODbL) and the restricted areas the
 * routing must avoid.
 */
/** Same vocabulary as `spot.exclude.reason`: a firing area is `military`. */
export const restrictedAreaReason = z.enum(["military", "cable", "protectedArea", "aquaculture", "ferryLane"]);

const coastProperties = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("land"), source: z.string().min(1), extractedAt: isoDate }),
  z.strictObject({ kind: z.literal("coastline"), source: z.string().min(1), extractedAt: isoDate }),
  z.strictObject({ kind: z.literal("restrictedArea"), reason: restrictedAreaReason, source: z.string().min(1) }),
]);

export const coastFeatureSchema = z.strictObject({
  type: z.literal("Feature"),
  geometry: z.discriminatedUnion("type", [geoPolygon, geoMultiPolygon, geoLineString, geoMultiLineString]),
  properties: coastProperties,
});

export const coastCollectionSchema = z.strictObject({
  type: z.literal("FeatureCollection"),
  features: z.array(coastFeatureSchema),
});

export type CoastFeature = z.infer<typeof coastFeatureSchema>;
export type CoastCollection = z.infer<typeof coastCollectionSchema>;
