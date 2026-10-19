import { z } from "zod";
import { geoObjectTypeEnum, poiCategoryEnum, restrictedKindEnum, type GeoObjectType } from "@/lib/db/schema/geo";

export const queueConfigSchema = z.object({
  concurrency: z.number().int().min(1),
  retryLimit: z.number().int().min(0),
  retryDelaySeconds: z.number().int().min(0),
  retryBackoff: z.boolean(),
});

export const BUDGET_SERVICES = ["anthropic", "voyage", "dataforseo", "firecrawl", "jina"] as const;
export type BudgetService = (typeof BUDGET_SERVICES)[number];

export const queuesSchema = z.record(z.string(), queueConfigSchema);

const budgetEntrySchema = z.strictObject({ dailyEur: z.number().positive() });

export const budgetsSchema = z.strictObject(
  Object.fromEntries(BUDGET_SERVICES.map((s) => [s, budgetEntrySchema])) as Record<
    BudgetService,
    typeof budgetEntrySchema
  >,
);

export const modelsSchema = z.object({
  tasks: z.record(
    z.string(),
    z.object({ model: z.string().min(1), promptVersion: z.number().int().min(1) }),
  ),
  pricesEurPerMTok: z.record(
    z.string(),
    z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }),
  ),
});

const configKey = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be lower case letters, digits and dashes");
const wikidataQid = z.string().regex(/^Q[1-9][0-9]*$/, "must be a Wikidata item id (Q…)");
const geoObjectType = z.enum(geoObjectTypeEnum.enumValues);
const poiCategory = z.enum(poiCategoryEnum.enumValues);

const REQUIRED_NAME_LANGUAGES = ["de", "en", "el"] as const;
const namesSchema = z
  .record(z.string().regex(/^[a-z]{2,3}$/, "must be an ISO 639 language code"), z.string().trim().min(1))
  .superRefine((names, ctx) => {
    for (const lang of REQUIRED_NAME_LANGUAGES) {
      if (!(lang in names)) ctx.addIssue({ code: "custom", message: `missing ${lang} name` });
    }
  });

const lon = z.number().min(-180).max(180);
const lat = z.number().min(-90).max(90);
const position = z.tuple([lon, lat]);
const linearRing = z
  .array(position)
  .min(4)
  .refine((ring) => ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1], "ring must be closed");
const polygonCoordinates = z.array(linearRing).min(1);
const polygonSchema = z.union([
  z.strictObject({ type: z.literal("Polygon"), coordinates: polygonCoordinates }),
  z.strictObject({ type: z.literal("MultiPolygon"), coordinates: z.array(polygonCoordinates).min(1) }),
]);

const bboxSchema = z
  .tuple([lon, lat, lon, lat])
  .refine(([w, s, e, n]) => w < e && s < n, "bbox must be [west, south, east, north] with west < east, south < north");

const coastSectionSchema = z.strictObject({ key: configKey, names: namesSchema, polygon: polygonSchema });

export const areaConfigSchema = z
  .strictObject({
    /** Equals the file name in `config/areas/`. */
    key: configKey,
    names: namesSchema,
    polygon: polygonSchema,
    /** Pilot tile box; `null` while the area has no tiles. */
    tileBbox: bboxSchema.nullable(),
    sourceLanguages: z.array(z.string().regex(/^[a-z]{2,3}$/)).min(1),
    season: z.strictObject({
      fromMonth: z.number().int().min(1).max(12),
      toMonth: z.number().int().min(1).max(12),
    }),
    cycleDays: z.number().int().min(1),
    coastSections: z.array(coastSectionSchema),
  })
  .superRefine((area, ctx) => {
    const keys = area.coastSections.map((s) => s.key);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) ctx.addIssue({ code: "custom", path: ["coastSections"], message: `duplicate coast section key ${dup}` });
  });

export const categoriesSchema = z.strictObject({
  osm: z.array(
    z.strictObject({
      key: z.string().min(1),
      values: z.union([z.literal("*"), z.array(z.string().min(1)).min(1)]),
      category: poiCategory,
    }),
  ),
  wikidata: z.record(wikidataQid, poiCategory),
});

const distanceMSchema = z.strictObject({
  default: z.number().positive(),
  ...Object.fromEntries(geoObjectTypeEnum.enumValues.map((t) => [t, z.number().positive().optional()])),
} as { default: z.ZodNumber } & Record<GeoObjectType, z.ZodOptional<z.ZodNumber>>);

export const gazetteerSchema = z.strictObject({
  overpass: z.strictObject({
    endpoint: z.url(),
    timeoutSeconds: z.number().int().positive(),
    ratePerMinute: z.number().positive(),
  }),
  wikidata: z.strictObject({
    endpoint: z.url(),
    languages: z.array(z.string().regex(/^[a-z]{2,3}$/)).min(1),
    classes: z.record(wikidataQid, geoObjectType),
    ratePerMinute: z.number().positive(),
  }),
  geonames: z.strictObject({
    baseUrl: z.url(),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
    featureCodes: z.record(z.string().regex(/^[A-Z0-9]+$/), geoObjectType),
    refreshDays: z.number().int().positive(),
  }),
  bboxBufferKm: z.number().nonnegative(),
  landBufferKm: z.number().nonnegative(),
  coastDistanceM: z.number().positive(),
  islandParentBufferM: z.number().nonnegative(),
  coastSectionMaxAreaKm2: z.number().positive(),
  merge: z.strictObject({
    trigramMin: z.number().min(0).max(1),
    uncertainTrigramMin: z.number().min(0).max(1),
    distanceM: distanceMSchema,
    uncertainDistanceFactor: z.number().min(1),
    wikidataLinkDistanceM: z.number().positive(),
    geonamesNewObjectRadiusM: z.number().positive(),
  }),
  noAnchoringKinds: z.array(z.enum(restrictedKindEnum.enumValues)),
});

/** `config/fact-schema/active.json`: the fact schema version new facts are written with. */
export const factSchemaConfigSchema = z.strictObject({
  version: z.string().regex(/^v[1-9][0-9]*$/, "must be v<number>"),
});

export type QueueConfig = z.infer<typeof queueConfigSchema>;
export type AreaConfig = z.infer<typeof areaConfigSchema>;
export type CategoriesConfig = z.infer<typeof categoriesSchema>;
export type GazetteerConfig = z.infer<typeof gazetteerSchema>;
export type AppConfig = {
  queues: Record<string, QueueConfig>;
  budgets: Record<BudgetService, { dailyEur: number }>;
  models: z.infer<typeof modelsSchema>;
  areas: AreaConfig[];
  categories: CategoriesConfig;
  gazetteer: GazetteerConfig;
  factSchema: z.infer<typeof factSchemaConfigSchema>;
};
