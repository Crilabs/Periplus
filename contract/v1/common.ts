import { z } from "zod";

/*
 * Building blocks of the Periplus Data Contract v1 (spec 08, `.idea/datendienst-spec.md` Teil B). Every object is
 * strict: a field outside the contract is an error. Refinements (five decimals) exist only in zod; the generated JSON
 * schemas carry everything else.
 */

/** The files of a package, in manifest order; `changes.json` from the second delivery on. */
export const CONTRACT_FILES = [
  "manifest.json",
  "spots.json",
  "highlights.json",
  "regions.json",
  "coast.geojson",
  "weather-points.json",
  "changes.json",
] as const;
export type ContractFile = (typeof CONTRACT_FILES)[number];

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

/** A public id `<prefix>_<ulid>` (Crockford base 32). */
export const publicId = (prefix: "sp" | "hl" | "rg" | "ar") =>
  z.string().regex(new RegExp(`^${prefix}_${ULID}$`), `must be ${prefix}_<ulid>`);
export const weatherPointId = z.string().regex(new RegExp(`^wp_${ULID}$`), "must be wp_<ulid>");

/** Teil B: "lat/lon als Dezimalgrad mit 5 Nachkommastellen" – at most five. */
const hasAtMostFiveDecimals = (v: number) => Number(v.toFixed(5)) === v;
const degrees = (min: number, max: number) =>
  z.number().min(min).max(max).refine(hasAtMostFiveDecimals, "at most 5 decimals");
export const latitude = degrees(-90, 90);
export const longitude = degrees(-180, 180);

export const latLon = z.strictObject({ lat: latitude, lon: longitude });
/** A share, confidence or shelter value. */
export const unit = z.number().min(0).max(1);
export const isoDate = z.iso.date();
export const isoDateTime = z.iso.datetime();
export const month = z.number().int().min(1).max(12);
export const count = z.number().int().min(0);

export const provenanceSource = z.enum(["computed", "text", "observed", "review"]);
export const sourceKind = z.enum([
  "pilotGuide",
  "tripReport",
  "forum",
  "marina",
  "authority",
  "dataset",
  "travelGuide",
  "other",
]);
/** A source for display: URL and kind only, never a passage. */
export const sourceRef = z.strictObject({ url: z.url(), kind: sourceKind, observedAt: isoDate });
export const textDe = z.strictObject({ de: z.string().min(1) });
export const highlightCategory = z.enum(["food", "supply", "beach", "nature", "active", "culture", "town", "quiet"]);

/** Version of the contract object (not of the internal profile) and the date it holds from. */
export const versionFields = { profileVersion: z.number().int().min(1), validFrom: isoDate };

/** GeoJSON position `[lon, lat]`. */
const position = z.tuple([longitude, latitude]);
const ring = z.array(position).min(4);
export const geoPolygon = z.strictObject({ type: z.literal("Polygon"), coordinates: z.array(ring).min(1) });
export const geoMultiPolygon = z.strictObject({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(z.array(ring).min(1)).min(1),
});
export const geoLineString = z.strictObject({ type: z.literal("LineString"), coordinates: z.array(position).min(2) });
export const geoMultiLineString = z.strictObject({
  type: z.literal("MultiLineString"),
  coordinates: z.array(z.array(position).min(2)).min(1),
});
export const areal = z.discriminatedUnion("type", [geoPolygon, geoMultiPolygon]);

/** Envelope of every object file of a package (all but manifest and coast). */
export const fileEnvelope = {
  schemaVersion: z.literal("1.0"),
  area: publicId("ar"),
  dataVersion: z.number().int().min(1),
  generatedAt: isoDateTime,
};
