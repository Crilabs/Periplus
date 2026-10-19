import { z } from "zod";
import {
  geoObjectTypeEnum,
  poiCategoryEnum,
  restrictedKindEnum,
  seabedTypeEnum,
  type GeoObjectType,
} from "@/lib/db/schema/geo";

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

const share = z.number().min(0).max(1);
const confidence = share;
const meters = z.number().positive();

/** `config/geometry.json`: parameters of the geometric computations; any change raises `rulesVersion`. */
export const geometrySchema = z.strictObject({
  rulesVersion: z.string().regex(/^geometry-[1-9][0-9]*$/, "must be geometry-<number>"),
  fetch: z
    .strictObject({
      rayCount: z.number().int().positive(),
      rayStepDeg: z.number().positive(),
      maxRayM: meters,
      confidence,
    })
    .refine((f) => f.rayCount * f.rayStepDeg === 360, "rayCount × rayStepDeg must be 360")
    .refine((f) => Number.isInteger(45 / f.rayStepDeg), "rayStepDeg must divide 45 so every sector centre is a ray"),
  shelter: z
    .strictObject({ fMinM: meters, fMaxM: meters, meanWeight: share, minWeight: share, confidence })
    .refine((s) => s.fMinM < s.fMaxM, "fMinM must be below fMaxM")
    .refine((s) => Math.abs(s.meanWeight + s.minWeight - 1) < 1e-9, "meanWeight + minWeight must be 1"),
  opening: z.strictObject({ openFetchM: meters, minResultant: share, confidence }),
  swell: z.strictObject({
    longFetchM: meters,
    openFetchM: meters,
    maxOpeningDeg: z.number().positive().max(360),
    wideOpeningFactor: share,
    noSourceValue: share,
    confidence,
  }),
  water: z.strictObject({
    bayRadiusM: meters,
    harbourRadiusM: meters,
    maxPolygonAreaM2: z.number().positive(),
    originCoastOffsetM: z.number().nonnegative(),
  }),
  depth: z.strictObject({
    sampleDistancesM: z.array(meters).min(1),
    hrResolutionM: meters,
    confidenceHr: confidence,
    confidenceCoarseWide: confidence,
    confidenceCoarseNarrow: confidence,
    minBayWidthM: meters,
  }),
  anchorArea: z
    .strictObject({
      minDepthM: z.number().nonnegative(),
      maxDepthM: meters,
      landClearanceM: z.number().nonnegative(),
      positionConfidence: confidence,
      correctionConfidence: confidence,
      correctionMaxDistanceM: meters,
    })
    .refine((a) => a.minDepthM < a.maxDepthM, "minDepthM must be below maxDepthM"),
  seabed: z.strictObject({ minCoverage: share, confidence }),
  restriction: z.strictObject({ minShare: share, confidence }),
});

/** `config/restrictions.json`: Natura 2000 sites (site codes) where anchoring is banned. */
export const restrictionsSchema = z.strictObject({
  protectedAreaAnchoringBan: z.array(
    z.string().regex(/^[A-Z]{2}[0-9A-Z]{7}$/, "must be a Natura 2000 site code (two letters, seven characters)"),
  ),
});

/** EMODnet Seabed Habitats WFS (EUSeaMap substrate layer) and the mapping of its classes to `seabed_type`. */
export const seabedDatasetSchema = z.strictObject({
  wfsUrl: z.url(),
  typeName: z.string().min(1),
  substrateField: z.string().min(1),
  /** Fields searched for `weedPatterns` (case-insensitive substring). */
  habitatFields: z.array(z.string().min(1)),
  /** Source substrate class → seabed type; unmapped classes are skipped. */
  substrateMap: z.record(z.string().min(1), z.enum(seabedTypeEnum.enumValues)),
  weedPatterns: z.array(z.string().trim().min(1)),
  pageSize: z.number().int().positive(),
  timeoutSeconds: z.number().int().positive(),
  ratePerMinute: z.number().int().positive(),
});

/** EMODnet Bathymetry WCS (mean depth of the DTM), native grid in EPSG:4326 with axes Long/Lat. */
export const bathymetryDatasetSchema = z.strictObject({
  wcsUrl: z.url(),
  coverageId: z.string().min(1),
  /** Name stored in `bathymetry.dataset` and in every derivation. */
  dataset: z.string().min(1),
  datasetVersion: z.string().min(1),
  resolutionM: meters,
  /** True when the source stores elevation (water negative); depths are stored positive. */
  valueIsElevation: z.boolean(),
  timeoutSeconds: z.number().int().positive(),
  ratePerMinute: z.number().int().positive(),
});

/** EMODnet Human Activities WFS: one layer per source of anchoring restrictions. */
export const humanActivitiesDatasetSchema = z.strictObject({
  wfsUrl: z.url(),
  layers: z
    .array(
      z.strictObject({
        typeName: z.string().min(1),
        kind: z.enum(restrictedKindEnum.enumValues),
        /** Buffer around the geometry in metres; needed for lines and points, 0 keeps polygons as they are. */
        bufferM: z.number().nonnegative(),
        /** Property holding a stable source id; omitted or missing on a feature = the GeoJSON feature id. */
        idField: z.string().min(1).optional(),
      }),
    )
    .min(1),
  pageSize: z.number().int().positive(),
  timeoutSeconds: z.number().int().positive(),
  ratePerMinute: z.number().int().positive(),
});

/**
 * EMODnet Human Activities WCS vessel density (download and archive only in M2). Its native grid is
 * EPSG:3857, so the Long/Lat subset needs `subsettingCrs`; `time` picks the annual slice.
 */
export const vesselDensityDatasetSchema = z.strictObject({
  wcsUrl: z.url(),
  coverageId: z.string().min(1),
  subsettingCrs: z.url(),
  time: z.iso.datetime(),
  dataset: z.string().min(1),
  datasetVersion: z.string().min(1),
  timeoutSeconds: z.number().int().positive(),
  ratePerMinute: z.number().int().positive(),
});

/**
 * Submarine cables from OSM (Overpass; EMODnet has no Mediterranean cable layer): stored as restricted
 * areas of `kind`, each line buffered by `bufferM`.
 */
export const cablesDatasetSchema = z.strictObject({
  kind: z.enum(restrictedKindEnum.enumValues),
  bufferM: z.number().positive(),
});

/** Roads from OSM (Overpass) for the distance to the next road; `highways` are the `highway` values kept. */
export const roadsDatasetSchema = z.strictObject({
  highways: z.array(z.string().regex(/^[a-z_]+$/)).min(1),
  /** Margin around the area's box for the road query, in km. */
  bufferKm: z.number().nonnegative(),
});

/** `config/datasets.json`: external datasets of the geometry stage. */
export const datasetsSchema = z.strictObject({
  bathymetry: bathymetryDatasetSchema,
  seabed: seabedDatasetSchema,
  humanActivities: humanActivitiesDatasetSchema,
  vesselDensity: vesselDensityDatasetSchema,
  cables: cablesDatasetSchema,
  roads: roadsDatasetSchema,
  /** Margin around an area's box for every dataset request, in km. */
  bufferKm: z.number().nonnegative(),
});

export type DatasetsConfig = z.infer<typeof datasetsSchema>;
export type QueueConfig = z.infer<typeof queueConfigSchema>;
export type GeometryConfig = z.infer<typeof geometrySchema>;
export type RestrictionsConfig = z.infer<typeof restrictionsSchema>;
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
  geometry: GeometryConfig;
  restrictions: RestrictionsConfig;
  datasets: DatasetsConfig;
};
