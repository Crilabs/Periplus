import { z } from "zod";
import { poiCategoryEnum } from "@/lib/db/schema/geo";
import type { AttributeDef, FactSchema } from "@/lib/domain/facts/schema-types";
import { factSchemaV1, SEABED_TYPES } from "./v1";

/*
 * Fact schema v2: every v1 attribute with its value schema, plus the attributes a model may extract from texts
 * for all five levels (spec 02 key list, spec 06). `textValue` is what the model delivers (language-neutral:
 * enums, numbers, proper names), `fromText` maps it to the stored value. Rule names follow spec 07.
 * A key present on several levels uses one shared definition object (attributeDef returns the first match).
 */

/** Shelter and swell words → 0–1 (spec 06: "gut/mäßig/kein Schutz" → 0.9 / 0.5 / 0.1); the prompt's mapping table. */
export const TEXT_SCALE = { good: 0.9, moderate: 0.5, poor: 0.1 } as const;
/** Exposure words → 0–1, for `meltemi_exposure`. */
export const EXPOSURE_SCALE = { low: 0.1, moderate: 0.5, high: 0.9 } as const;

const scaleWords = <S extends Record<string, number>>(scale: S) => ({
  textValue: z.enum(Object.keys(scale) as [keyof S & string, ...(keyof S & string)[]]),
  fromText: (word: unknown) => scale[word as keyof S],
});

const month = z.number().int().min(1).max(12);
const months = z.array(month);
const properName = z.string().min(1).max(80);
const MONTH_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] as const;

const v1Place = factSchemaV1.levels.place;
const v1Def = (key: string): AttributeDef => {
  const def = v1Place.find((d) => d.key === key);
  if (!def) throw new Error(`fact schema v1 has no attribute ${key}`);
  return def;
};

/** Extras for v1 attributes that already allow origin `text`; their value schema stays the v1 one. */
const textExtras = (key: string): Partial<AttributeDef> => {
  if (key.startsWith("shelter.") || key === "swell_protection") return scaleWords(TEXT_SCALE);
  if (["depth.min", "depth.max", "depth.anchoring_min", "depth.anchoring_max"].includes(key)) {
    return { textValue: z.number().min(0).max(200) };
  }
  if (key === "seabed") {
    return {
      // Seabed types without shares: equal shares, summing to 1.
      textValue: z.array(z.enum(SEABED_TYPES)).min(1),
      fromText: (types: unknown) => {
        const unique = [...new Set(types as string[])];
        return unique.map((type) => ({ type, share: 1 / unique.length }));
      },
    };
  }
  return {};
};

const prohibitionText = z.strictObject({
  kind: z.enum(["anchoring", "swimming", "fishing", "fire", "jet_ski", "other"]),
  months: months.min(1).nullable(),
});
const v1Prohibitions = v1Def("prohibitions");

/** v1 computed entries and text entries in one list (ruling M4-P10): every v1 value stays valid. */
const prohibitions: AttributeDef = {
  ...v1Prohibitions,
  value: z.array(z.union([(v1Prohibitions.value as z.ZodArray<z.ZodType>).element, prohibitionText])),
  origins: ["computed", "text"],
  textValue: z.array(prohibitionText).min(1),
  description: "Prohibitions at the place: restricted areas over the anchor area (computed) or stated bans (text) with months",
};

const hazards: AttributeDef = {
  key: "hazards",
  value: z
    .array(
      z.strictObject({
        kind: z.enum(["rock", "shoal", "wreck", "cable", "current", "swell", "fish_farm", "other"]),
        name: properName.nullable(),
      }),
    )
    .min(1),
  rule: "default",
  origins: ["text"],
  description: "Navigational hazards named in the text, with the proper name if given",
};

const seasonNotes: AttributeDef = {
  key: "season_notes",
  value: z.strictObject({
    months: months.min(1),
    kind: z.enum(["open", "closed", "crowded", "meltemi", "other"]),
  }),
  rule: "default",
  origins: ["text"],
  description: "Seasonal note: the months it applies to and what applies (open, closed, crowded, meltemi)",
};

const textOnly = (key: string, value: z.ZodType, rule: string, description: string): AttributeDef => ({
  key,
  value,
  rule,
  origins: ["text"],
  description,
});

const place: AttributeDef[] = [
  ...v1Place.map((def): AttributeDef => {
    if (def.key === "prohibitions") return prohibitions;
    return def.origins.includes("text") ? { ...def, ...textExtras(def.key) } : def;
  }),
  textOnly("holding", z.enum(["good", "moderate", "poor"]), "holding", "Holding of the anchor in the seabed"),
  textOnly(
    "mooring.types",
    z.array(z.enum(["anchor", "buoy", "lines_ashore", "stern_to", "alongside", "pontoon"])).min(1),
    "default",
    "Ways to moor at the place",
  ),
  textOnly(
    "mooring.buoys",
    z.strictObject({ present: z.boolean(), count: z.number().int().min(1).nullable(), paid: z.boolean().nullable() }),
    "latest_observation",
    "Mooring buoys: present, how many, whether they cost a fee",
  ),
  textOnly("mooring.line_ashore_required", z.boolean(), "default", "Whether a line ashore is required"),
  textOnly("capacity", z.number().int().min(1).max(2000), "default", "Number of boats the place holds"),
  textOnly("max_draft", z.number().positive(), "default", "Maximum draft that fits, metres"),
  textOnly("max_length", z.number().positive(), "default", "Maximum boat length that fits, metres"),
  textOnly(
    "occupancy",
    z
      .partialRecord(z.enum(MONTH_KEYS), z.enum(["empty", "moderate", "full"]))
      .refine((byMonth) => Object.keys(byMonth).length >= 1, "at least one month"),
    "occupancy",
    "How full the place is, per month (1 = January)",
  ),
  ...(["water", "electricity", "fuel", "dinghy_landing", "waste", "showers", "wifi"] as const).map((service) =>
    textOnly(`services.${service}`, z.boolean(), "latest_observation", `Whether ${service.replace("_", " ")} is available`),
  ),
  hazards,
  ...poiCategoryEnum.enumValues.map((category) =>
    textOnly(
      `highlight.${category}`,
      z.strictObject({ present: z.boolean(), names: z.array(properName).max(10) }),
      "highlight",
      `Highlights of category ${category} nearby: present, and their proper names (no descriptions)`,
    ),
  ),
  textOnly("quietness", z.enum(["quiet", "moderate", "busy", "noisy"]), "default", "How quiet the place is"),
  seasonNotes,
  textOnly(
    "prices",
    z.strictObject({
      amount: z.number().min(0),
      currency: z.literal("EUR"),
      unit: z.enum(["night", "meter_night", "other"]),
    }),
    "default",
    "Mooring fee in EUR and what it is charged per",
  ),
  textOnly(
    "contact",
    z.strictObject({
      vhf: z.string().max(10).nullable(),
      phone: z.string().max(30).nullable(),
      url: z.url().nullable(),
    }),
    "default",
    "Contact of the harbour or marina: VHF channel, phone, website",
  ),
];

const namedZones = (kinds: [string, ...string[]]) =>
  z.array(z.strictObject({ kind: z.enum(kinds), name: properName.nullable() })).min(1);

/** Area and island share every attribute (spec 02: "Revier/Insel"). */
const region: AttributeDef[] = [
  {
    key: "meltemi_exposure",
    value: z.number().min(0).max(1),
    ...scaleWords(EXPOSURE_SCALE),
    rule: "area_weighted",
    origins: ["text"],
    description: "Exposure to the meltemi, 0 (none) to 1 (fully exposed)",
  },
  textOnly(
    "wind_systems",
    z
      .array(
        z.strictObject({
          name: z.enum(["meltemi", "sirocco", "bora", "maestral", "land_breeze", "other"]),
          months,
        }),
      )
      .min(1),
    "area_weighted",
    "Prevailing wind systems and their months",
  ),
  textOnly("ferry_traffic", z.enum(["none", "low", "moderate", "high"]), "area_weighted", "Amount of ferry traffic"),
  textOnly(
    "restricted_zones",
    namedZones(["military", "firing", "protected", "other"]),
    "area_weighted",
    "Restricted zones named in the text, with the proper name if given",
  ),
  textOnly("charter_bases", z.array(properName).min(1), "area_weighted", "Proper names of charter bases"),
  textOnly("supply_ports", z.array(properName).min(1), "area_weighted", "Proper names of ports for supplies"),
];

const capeStrait: AttributeDef[] = [
  textOnly(
    "passage_notes",
    z.strictObject({
      difficulty: z.enum(["easy", "moderate", "difficult"]),
      notes: z.array(z.enum(["acceleration", "current", "overfalls", "traffic", "shallow"])),
    }),
    "default",
    "How difficult the passage is and why",
  ),
  textOnly("sea_state", z.enum(["calm", "moderate", "rough"]), "default", "Typical sea state"),
  hazards,
];

const poi: AttributeDef[] = [
  textOnly("exists", z.boolean(), "latest_observation", "Whether the place of interest still exists"),
  seasonNotes,
  textOnly("dinghy_access", z.boolean(), "latest_observation", "Whether it can be reached by dinghy"),
];

export const factSchemaV2: FactSchema = {
  version: "v2",
  levels: { place, area: region, island: region, cape_strait: capeStrait, poi },
};
