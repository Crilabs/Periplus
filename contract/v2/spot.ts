import { z } from "zod";
import {
  combinedSource,
  count,
  googlePlaceId,
  highlightCategory,
  httpUrl,
  isoDate,
  latitude,
  latLon,
  longitude,
  month,
  nearbyCategory,
  osmId,
  provenanceSource,
  publicId,
  unit,
  wikidataId,
} from "./common";
import { placeImageSchema } from "./image";

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

/**
 * A free fact about the spot or about something on land (contract 4.0). A landside fact points at the `nearby` entry of
 * its object by `id`; without a match it carries only the `name` the text gave (coordinates are never guessed).
 */
export const factSchema = z
    .strictObject({
    id: publicId("fc"),
    subject: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("spot") }),
      z.strictObject({ kind: z.literal("landside"), id: publicId("hl").nullable(), name: z.string().min(1).nullable() }),
    ]),
    text: z.string().min(1),
    observedAt: isoDate.nullable(),
    tone: z.enum(["positive", "negative", "neutral"]).nullable(),
    safety: z.boolean(),
    mentions: count,
  })
  .refine((f) => f.subject.kind === "spot" || f.subject.id !== null || f.subject.name !== null, {
    message: "a landside fact needs an id or a name",
    path: ["subject"],
  });

/** Where a dinghy or a crew can get ashore: a mapped point or a description. */
export const landingPointSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(["harbour", "pier", "slipway", "beach", "shore"]), position: latLon }),
  z.strictObject({ kind: z.literal("text"), description: z.string().min(1) }),
]);

/** Something reachable on land from the spot, by its public `hl_` id. */
export const nearbyEntrySchema = z.strictObject({
  id: publicId("hl"),
  category: nearbyCategory,
  name: z.string().min(1),
  names: z
    .array(z.strictObject({ lang: z.string().min(2), name: z.string().min(1), script: z.enum(["latin", "greek"]) }))
    .optional(),
  position: latLon,
  distanceM: count,
  access: z.enum(["foot", "transport"]),
});

export const spotSchema = z.strictObject({
  id: publicId("sp"),
  kind: spotKind.describe(
    "marina: leisure harbour where recreational boats berth, including the town quay of an island harbour where yachts moor stern-to without operator or website, even if ferries also use the mole. " +
      "anchorage: a place where one can anchor. " +
      "mooringField: a place where a recreational boat moors to a buoy. " +
      "port: commercial or industrial harbour (ferries, freight, fishing, shipyard) without berths for recreational boats.",
  ),
  /** Whether a charter crew passing through can moor here (anchor, visitor berth or quay, free buoy); null = unknown; contract 2.3. */
  berthable: z.boolean().nullable().describe("Charter crew can moor here on a short stay"),
  /** How to register with the marina or harbour (VHF channel, phone, website); null when nothing is known; contract 2.3. */
  contact: z
    .strictObject({ vhf: z.string().nullable(), phone: z.string().nullable(), url: httpUrl.nullable() })
    .nullable()
    .describe("How to call the marina or harbour"),
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
      shop: service.describe("Supermarket or mini market nearby or by text"),
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
  externalRefs: z
    .strictObject({
      googlePlaceIds: z.partialRecord(highlightCategory, z.array(googlePlaceId)),
      osmId: osmId.nullable(),
      wikidataId: wikidataId.nullable(),
    })
    .optional(),
  /** Title and further views, best first (rank, sort order, slot); contract 2.1. */
  images: z.array(placeImageSchema).min(1).optional(),
  /** Per attribute, flat (`shelter`, `services.taverna` …). */
  provenance: z.record(
    z.string().min(1),
    z.strictObject({ source: provenanceSource, confidence: unit, observedAt: isoDate.nullable() }),
  ),
  regionId: publicId("rg").nullable().optional(),
  mergedInto: publicId("sp").nullable(),
  /** Date of the berth state the spot was built from; null for an excluded spot without a state (contract 4.0). */
  asOf: isoDate.nullable(),
  /** Core value keys the state has no value for, so the app can show the gap (contract 4.0). */
  gaps: z.array(z.string().min(1)),
  facts: z.array(factSchema),
  landingPoints: z.array(landingPointSchema),
  nearby: z.array(nearbyEntrySchema),
});

export type Spot = z.infer<typeof spotSchema>;
export type Fact = z.infer<typeof factSchema>;
export type LandingPoint = z.infer<typeof landingPointSchema>;
export type NearbyEntry = z.infer<typeof nearbyEntrySchema>;
/** A spot without `asOf`: what the content hash is taken over. */
export type SpotBody = Omit<Spot, "asOf">;
