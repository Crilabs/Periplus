import { z } from "zod";
import {
  geoObjectTypeEnum,
  poiCategoryEnum,
  restrictedKindEnum,
  seabedTypeEnum,
  type GeoObjectType,
} from "@/lib/db/schema/geo";
import { changeRateEnum, DOC_TYPES, type ChangeRate, type DocType } from "@/lib/db/schema/sources";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { CONVERTERS, crawlRulesPatchSchema, regexPattern } from "@/lib/domain/sources/crawl-rules";

export const queueConfigSchema = z.object({
  concurrency: z.number().int().min(1),
  retryLimit: z.number().int().min(0),
  retryDelaySeconds: z.number().int().min(0),
  retryBackoff: z.boolean(),
  /** Seconds a job may stay active before pg-boss expires and retries it (pg-boss default 900 when omitted). */
  expireInSeconds: z.number().int().min(1).optional(),
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

export const MODEL_EFFORTS = ["low", "medium", "high"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

const modelTaskSchema = z.strictObject({
  model: z.string().min(1),
  promptVersion: z.number().int().min(1),
  /** Output effort (`output_config.effort`); the default differs per model, so text tasks set it explicitly. */
  effort: z.enum(MODEL_EFFORTS).default("low"),
  /**
   * Longest answer of the task in tokens (`max_tokens`), required per task. Thinking is always on for the 5.5
   * models and counts against it, so a short label still needs room (ruling M4-P7).
   */
  maxTokens: z.number().int().min(1),
  /** Marks the rendered system prompt for prompt caching; only for tasks whose system prompt is identical per request. */
  cacheSystem: z.boolean().default(false),
  /** Model decision of the task (e.g. after the model comparison), shown on the settings page. */
  decision: z.strictObject({ status: z.enum(["provisional", "decided"]), note: z.string().trim().min(1) }).optional(),
});

export const modelsSchema = z
  .strictObject({
    tasks: z.record(z.string(), modelTaskSchema),
    /**
     * Prices per million tokens. A cache read costs `cacheReadFactor` x input price (per model), a cache write
     * `cacheWriteFactor` x input price (ruling M4-P5).
     */
    pricesEurPerMTok: z.record(
      z.string(),
      z.strictObject({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cacheReadFactor: z.number().nonnegative(),
      }),
    ),
    cacheWriteFactor: z.number().nonnegative(),
    /** Message Batches: price factor, poll interval, give-up time and requests per batch, and the send protocol. */
    batch: z
      .strictObject({
        discount: z.number().positive().max(1),
        pollSeconds: z.number().int().positive(),
        maxHours: z.number().positive(),
        maxRequests: z.number().int().positive(),
        /** Longest provider call (submit, cancel, list); the SDK never retries a submit (ruling M4-C-R6). */
        providerTimeoutSeconds: z.number().int().positive(),
        /** How long a claimed batch belongs to its sender; must outlast the provider call. */
        leaseSeconds: z.number().int().positive(),
        /** Clock difference allowed between the provider's `created_at` and ours when adopting a batch. */
        clockSkewSeconds: z.number().int().nonnegative(),
        /** Reservations count only for batches younger than this (provider expiry 24 h plus collection lag). */
        reservationHours: z.number().positive(),
        /** Delay before a batch send that hit the budget is tried again. */
        budgetRetrySeconds: z.number().int().positive(),
      })
      .refine((b) => b.leaseSeconds > b.providerTimeoutSeconds, {
        path: ["leaseSeconds"],
        message: "must be longer than providerTimeoutSeconds",
      })
      .refine((b) => b.reservationHours > b.maxHours, { path: ["reservationHours"], message: "must be longer than maxHours" }),
    /** Models compared on the same extraction units (spec 06). */
    comparison: z.strictObject({ models: z.array(z.string().min(1)).min(2) }),
  })
  .superRefine((models, ctx) => {
    for (const [name, task] of Object.entries(models.tasks)) {
      if (!(task.model in models.pricesEurPerMTok)) {
        ctx.addIssue({ code: "custom", path: ["tasks", name, "model"], message: `no price for model ${task.model}` });
      }
    }
    models.comparison.models.forEach((model, i) => {
      if (!(model in models.pricesEurPerMTok)) {
        ctx.addIssue({ code: "custom", path: ["comparison", "models", i], message: `no price for model ${model}` });
      }
    });
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
    /** Wikibase API (`wbgetentities`), e.g. for the Wikivoyage sitelinks of gazetteer objects. */
    apiEndpoint: z.url(),
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

/** `config/quality.json`: parameters of the quality tools (spot check against the comparison set). */
export const qualitySchema = z.strictObject({
  navilySample: z.strictObject({
    /** A Navily spot counts as the same place within this distance. */
    radiusM: meters,
    /** Own shelter at or above this value counts as a protected sector. */
    protectedThreshold: share,
    /** Own seabed types below this share do not count as the place's seabed. */
    seabedMinShare: share,
    /** Spec 04: the sample covers 20 places. */
    minPlaces: z.number().int().positive(),
    /** Per-sector rates are only reported from this many matched places on (no reconstruction of single spots). */
    minMatchedForSectorRates: z.number().int().positive(),
  }),
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
  /** Attribute the WFS pages are sorted by (the layer has no primary key GeoServer could page by). */
  sortBy: z.string().min(1),
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

const docType = z.enum(DOC_TYPES);
const changeRate = z.enum(changeRateEnum.enumValues);
const positiveInt = z.number().int().positive();
const eur = z.number().nonnegative();
const languageCode = z.string().regex(/^[a-z]{2,3}$/, "must be an ISO 639 language code");
const domainName = z
  .string()
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "must be a lower-case domain name without scheme or path");

const sourceTypeEntrySchema = z.strictObject({ weight: share, changeRate });

/** `config/source-types.json`: default weight and change rate per document type (spec 05). */
export const sourceTypesSchema = z.strictObject(
  Object.fromEntries(DOC_TYPES.map((t) => [t, sourceTypeEntrySchema])) as Record<DocType, typeof sourceTypeEntrySchema>,
);

const queryTemplateSchema = z.strictObject({
  template: z.string().refine((t) => t.includes("{name}"), "must contain {name}"),
  lang: languageCode,
  /** DataForSEO location code (e.g. 2276 Germany, 2826 United Kingdom, 2300 Greece). */
  locationCode: positiveInt,
});

/** `config/discovery.json`: SERP search, query templates and the thresholds for source proposals. */
export const discoverySchema = z.strictObject({
  serp: z.strictObject({
    endpoint: z.url(),
    depth: positiveInt,
    /** The same query is not searched again within this many days. */
    reuseDays: positiveInt,
    maxQueriesPerRun: positiveInt,
    costPerQueryEur: eur,
    ratePerMinute: z.number().positive(),
    timeoutMs: positiveInt,
  }),
  templates: z.strictObject({ area: z.array(queryTemplateSchema), tile: z.array(queryTemplateSchema) }),
  /** A named bay becomes a tile query with an anchor area of at least this size or this many Wikidata names. */
  bay: z.strictObject({ minAnchorAreaM2: z.number().positive(), minWikidataNames: positiveInt }),
  proposals: z.strictObject({
    minSerpHits: positiveInt,
    minLinkingSources: positiveInt,
    maxHitsInContext: positiveInt,
    /** Registrable domains never proposed. */
    ignoreDomains: z.array(domainName),
    /** In order of precedence; patterns match `host + pathname`, case-insensitive. */
    typeHints: z.array(z.strictObject({ pattern: regexPattern, type: docType })),
    defaultType: docType,
  }),
});

/** `config/fetch.json`: fetching, conversion, chunking and the converter decision. */
export const fetchSchema = z.strictObject({
  defaultConverter: z.enum(CONVERTERS),
  /**
   * Source domain (registrable, lower case, as in `sources.domain`) → converter, overriding `defaultConverter`.
   * Keyed by domain, not source id: this file is shared by all environments, whose source ids differ.
   */
  converterBySource: z.record(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "must be a lower-case domain"), z.enum(CONVERTERS)),
  decision: z.strictObject({ status: z.enum(["provisional", "decided"]), note: z.string().trim().min(1) }),
  /** `render: auto` renders a page whose HTTP text has less main content than this many characters. */
  renderMinMainChars: positiveInt,
  timeoutMs: positiveInt,
  maxRawBytes: positiveInt,
  maxRateWaitMs: positiveInt,
  /** Consecutive 404/410 answers after which a document is `gone`. */
  goneAfter: positiveInt,
  /** Query parameters dropped by URL normalisation; an entry ending in `*` is a prefix. */
  trackingParams: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\*?$/, "must be a parameter name, optionally ending in *")),
  /** ISO 639-3 (language detection) → ISO 639-1 code stored on documents. */
  languages: z.record(z.string().regex(/^[a-z]{3}$/), z.string().regex(/^[a-z]{2}$/)),
  chunk: z
    .strictObject({ targetWords: positiveInt, maxWords: positiveInt, maxOverlapWords: z.number().int().nonnegative() })
    .refine((c) => c.targetWords <= c.maxWords, "targetWords must not exceed maxWords"),
  pdf: z.strictObject({
    extractor: z.literal("pdftotext"),
    modelFallback: z.boolean(),
    /** Extracted text below this many characters counts as unreadable. */
    unreadableMinChars: z.number().int().nonnegative(),
    maxModelPagesPerDocument: positiveInt,
  }),
  jina: z.strictObject({ endpoint: z.url(), eurPerMTok: eur, timeoutMs: positiveInt }),
  firecrawl: z.strictObject({ endpoint: z.url(), eurPerCredit: eur, timeoutMs: positiveInt }),
});

/** `config/embeddings.json`: embedding provider, model and dimension of `chunks.embedding`. */
export const embeddingsSchema = z.strictObject({
  provider: z.literal("voyage"),
  endpoint: z.url(),
  model: z.string().min(1),
  dimension: positiveInt,
  batchSize: positiveInt,
  eurPerMTok: eur,
  ratePerMinute: z.number().positive(),
  timeoutMs: positiveInt,
});

/** `config/sources-whitelist.json`: sources created as approved without a proposal. */
export const whitelistSchema = z
  .array(
    z.strictObject({
      domain: domainName,
      name: z.string().trim().min(1),
      type: docType,
      changeRate,
      crawlRules: crawlRulesPatchSchema,
    }),
  )
  .superRefine((entries, ctx) => {
    const domains = entries.map((e) => e.domain);
    const dup = domains.find((d, i) => domains.indexOf(d) !== i);
    if (dup) ctx.addIssue({ code: "custom", message: `duplicate domain ${dup}` });
  });

/** `config/mentions.json`: finding mentions of gazetteer objects in chunks (spec 06). */
export const mentionsSchema = z
  .strictObject({
    /** Exact matches only for names with at least this many characters. */
    exactMinChars: positiveInt,
    /** Trigram matches only for names with at least this many characters. */
    fuzzyMinChars: positiveInt,
    /** `similarity` at or above this is a sure match. */
    sureSimilarity: share,
    /** `similarity` from here up to `sureSimilarity` is ambiguous. */
    uncertainSimilarity: share,
    maxNgramWords: positiveInt,
    /** At most this many candidate objects go to the disambiguation. */
    maxCandidates: positiveInt,
    /** Tile ring around the tiles a document touches; 2 is a test switch. */
    neighbourRing: z.union([z.literal(1), z.literal(2)]),
    versionsPerJob: positiveInt,
    /** Object types matched against the whole text first, to find the tiles a document touches. */
    prepassTypes: z.array(geoObjectType).min(1),
    /** Candidate space when a document touches no tile: the areas of its source. */
    fallbackScope: z.literal("source_areas"),
    /** Normalized words that never form a mention on their own. */
    stopNames: z.array(z.string().min(1).refine((n) => n === normalizeName(n), "must be normalized (normalizeName)")),
    /** Normalized capitalised words that never belong to a new-name hint (sentence starts, common nouns). */
    nameHintStopWords: z.array(z.string().min(1).refine((n) => n === normalizeName(n), "must be normalized (normalizeName)")),
  })
  .refine((m) => m.uncertainSimilarity < m.sureSimilarity, "uncertainSimilarity must be below sureSimilarity");

export const NAME_AFFIX_HINTS = ["bay", "harbour", "anchorage", "cape", "island", "marina"] as const;

/** `config/name-affixes.json`: generic name parts (normalized) stripped before matching, with the type they hint at. */
export const nameAffixesSchema = z
  .array(
    z.strictObject({
      affix: z.string().min(1).refine((a) => a === normalizeName(a), "must be normalized (normalizeName)"),
      position: z.enum(["prefix", "suffix"]),
      hint: z.enum(NAME_AFFIX_HINTS),
    }),
  )
  .superRefine((entries, ctx) => {
    const keys = entries.map((e) => `${e.position}:${e.affix}`);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) ctx.addIssue({ code: "custom", message: `duplicate affix ${dup}` });
  });

/** `config/extraction.json`: classification, extraction units, quote check, geocoding and the model comparison. */
export const extractionSchema = z.strictObject({
  quote: z
    .strictObject({ minChars: positiveInt, maxChars: positiveInt })
    .refine((q) => q.minChars < q.maxChars, "minChars must be below maxChars"),
  unit: z.strictObject({ neighbourChunks: z.number().int().nonnegative(), maxChunksPerUnit: positiveInt }),
  maxFactsPerUnit: positiveInt,
  unitsPerBatch: positiveInt,
  /** The classification reads title, URL and the first this many words. */
  classifyWords: positiveInt,
  /** Documents with more words in sections go to the route extraction. */
  routeSectionWords: positiveInt,
  /** A highlight POI matches a gazetteer POI within this distance. */
  poiMatchRadiusM: meters,
  poiSimilarity: share,
  geocode: z.strictObject({
    minDocuments: positiveInt,
    minSources: positiveInt,
    radiusKm: z.number().positive(),
    limit: positiveInt,
    endpoint: z.url(),
    ratePerMinute: z.number().positive(),
  }),
  /** Observation dates before this are treated as wrong. */
  earliestDate: z.iso.date(),
  comparison: z.strictObject({
    units: positiveInt,
    minSources: positiveInt,
    ratingSample: positiveInt,
    numericTolerance: share,
    /** Estimated system prompt tokens per unit (cost estimate before the start). */
    systemTokens: positiveInt,
    /** Estimated output tokens per unit incl. thinking (cost estimate before the start). */
    outputTokensPerUnit: positiveInt,
  }),
});

export type ModelsConfig = z.infer<typeof modelsSchema>;
export type ModelTaskConfig = z.infer<typeof modelTaskSchema>;
export type MentionsConfig = z.infer<typeof mentionsSchema>;
export type NameAffixesConfig = z.infer<typeof nameAffixesSchema>;
export type ExtractionConfig = z.infer<typeof extractionSchema>;
export type SourceTypesConfig = Record<DocType, { weight: number; changeRate: ChangeRate }>;
export type DiscoveryConfig = z.infer<typeof discoverySchema>;
export type FetchConfig = z.infer<typeof fetchSchema>;
export type EmbeddingsConfig = z.infer<typeof embeddingsSchema>;
export type WhitelistConfig = z.infer<typeof whitelistSchema>;
export type DatasetsConfig = z.infer<typeof datasetsSchema>;
export type QueueConfig = z.infer<typeof queueConfigSchema>;
export type GeometryConfig = z.infer<typeof geometrySchema>;
export type QualityConfig = z.infer<typeof qualitySchema>;
export type RestrictionsConfig = z.infer<typeof restrictionsSchema>;
export type AreaConfig = z.infer<typeof areaConfigSchema>;
export type CategoriesConfig = z.infer<typeof categoriesSchema>;
export type GazetteerConfig = z.infer<typeof gazetteerSchema>;
export type AppConfig = {
  queues: Record<string, QueueConfig>;
  budgets: Record<BudgetService, { dailyEur: number }>;
  models: ModelsConfig;
  areas: AreaConfig[];
  categories: CategoriesConfig;
  gazetteer: GazetteerConfig;
  factSchema: z.infer<typeof factSchemaConfigSchema>;
  geometry: GeometryConfig;
  restrictions: RestrictionsConfig;
  datasets: DatasetsConfig;
  quality: QualityConfig;
  sourceTypes: SourceTypesConfig;
  discovery: DiscoveryConfig;
  fetch: FetchConfig;
  embeddings: EmbeddingsConfig;
  whitelist: WhitelistConfig;
  mentions: MentionsConfig;
  nameAffixes: NameAffixesConfig;
  extraction: ExtractionConfig;
};
