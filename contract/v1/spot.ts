import { z } from "zod";
import {
  combinedSource,
  count,
  googlePlaceId,
  highlightCategory,
  isoDate,
  latitude,
  latLon,
  longitude,
  month,
  osmId,
  provenanceSource,
  publicId,
  sourceRef,
  textDe,
  unit,
  versionFields,
  wikidataId,
} from "./common";

/** Spot (Teil B "Spot"); required fields are the bold ones of Teil B. */

const nullableMetres = z.number().nonnegative().nullable();
const service = z.enum(["yes", "no", "seasonal", "unknown"]);

export const spotKind = z.enum(["anchorage", "port", "marina", "mooringField"]);
export const excludeReason = z.enum([
  "anchoringProhibited",
  "military",
  "cable",
  "protectedArea",
  "ferryLane",
  "unsafe",
  "aquaculture",
]);
export const hazardKind = z.enum([
  "rock",
  "shoal",
  "cable",
  "wreck",
  "ferryTraffic",
  "gusts",
  "swellEntry",
  "current",
  "fishFarm",
  "other",
]);

export const spotSchema = z.strictObject({
  id: publicId("sp"),
  kind: spotKind,
  /** Display name, Latin script preferred (Teil B): German, English, the own Latin name, else the ELOT 743 transliteration of the preferred Greek name (never of an old or alternate name). */
  name: z.string().min(1),
  /** `lang` is a BCP 47 tag (`el`, `en`, `de`, …); the transliteration of a Greek name is `el-Latn`, script `latin`. */
  names: z
    .array(z.strictObject({ lang: z.string().min(2), name: z.string().min(1), script: z.enum(["latin", "greek"]) }))
    .optional(),
  position: latLon,
  anchorPosition: z
    .strictObject({ lat: latitude, lon: longitude, confidence: unit, source: provenanceSource })
    .optional(),
  shelter: z.strictObject({
    sectors: z.strictObject({ N: unit, NE: unit, E: unit, SE: unit, S: unit, SW: unit, W: unit, NW: unit }),
    swell: unit,
    /** Origins that made the value, e.g. `computed`, `computed+text`. */
    source: combinedSource,
  }),
  depth: z
    .strictObject({
      min: nullableMetres,
      max: nullableMetres,
      anchoring: z.strictObject({ min: nullableMetres, max: nullableMetres }),
      confidence: unit,
      source: combinedSource,
    })
    .optional(),
  seabed: z
    .array(z.strictObject({ type: z.enum(["sand", "mud", "weed", "rock", "gravel", "mixed"]), share: unit }))
    .optional(),
  holding: z.enum(["good", "fair", "poor", "unknown"]).optional(),
  limits: z.strictObject({ maxDraft: nullableMetres, maxLength: nullableMetres, capacity: count.nullable() }),
  mooring: z
    .strictObject({
      types: z.array(z.enum(["anchor", "buoy", "sternTo", "alongside", "lineAshore"])),
      buoys: count.nullable(),
      lineAshoreRequired: z.boolean().nullable(),
    })
    .optional(),
  services: z
    .strictObject({
      water: service,
      electricity: service,
      fuel: service,
      showers: service,
      shop: service,
      taverna: service,
      wifi: service,
      dinghyLanding: service,
    })
    .optional(),
  berth: z
    .strictObject({
      status: z.enum(["oftenFull", "seasonFull", "usuallySpace", "unknown"]),
      months: z.array(month),
      sourcesCount: count,
      bookable: z.boolean().nullable(),
    })
    .optional(),
  occupancy: z
    .array(z.strictObject({ month, level: z.enum(["empty", "moderate", "full", "unknown"]) }))
    .optional(),
  exclude: z.strictObject({
    excluded: z.boolean(),
    reason: excludeReason.nullable(),
    detail: z.string().nullable(),
  }),
  hazards: z.array(z.strictObject({ kind: hazardKind, text: z.string().min(1) })).optional(),
  seasonNote: z.array(z.strictObject({ months: z.array(month).min(1), text: z.string().min(1) })).optional(),
  score: z.strictObject({
    confidence: unit,
    popularity: unit,
    quietness: unit.nullable(),
    sourcesCount: count,
    lastObserved: isoDate.nullable(),
  }),
  highlightIds: z.array(publicId("hl")).optional(),
  externalRefs: z
    .strictObject({
      googlePlaceIds: z.partialRecord(highlightCategory, z.array(googlePlaceId)),
      osmId: osmId.nullable(),
      wikidataId: wikidataId.nullable(),
    })
    .optional(),
  summary: textDe.optional(),
  sources: z.array(sourceRef).optional(),
  /** Per attribute, flat (`shelter`, `services.taverna` …). */
  provenance: z.record(
    z.string().min(1),
    z.strictObject({ source: provenanceSource, confidence: unit, observedAt: isoDate.nullable() }),
  ),
  regionId: publicId("rg").nullable().optional(),
  mergedInto: publicId("sp").nullable(),
  ...versionFields,
});

export type Spot = z.infer<typeof spotSchema>;
/** A spot without its version fields: what the content hash is taken over. */
export type SpotBody = Omit<Spot, "profileVersion" | "validFrom">;
