import { z } from "zod";
import { FACT_SCHEMAS } from "@/config/fact-schema";
import {
  geoObjectTypeEnum,
  placeKindEnum,
  placeStatusEnum,
  poiCategoryEnum,
  restrictedKindEnum,
  seabedTypeEnum,
  type GeoObjectType,
  type PlaceKind,
} from "@/lib/db/schema/geo";
import { pageKindEnum } from "@/lib/db/schema/research";
import { berthSignalKindEnum } from "@/lib/db/schema/research-extract";
import { changeRateEnum, DOC_TYPES, type ChangeRate, type DocType } from "@/lib/db/schema/sources";
import { CONTRACT_FILES, SCHEMA_VERSION } from "@/contract";
import { PROVENANCE_SOURCES, RADIUS_MAX_DAYS } from "@/contract/v2";
import { COPY_SHINGLE_WORDS } from "@/lib/domain/documents/shingles";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { CONVERTERS, crawlRulesPatchSchema, regexPattern } from "@/lib/domain/sources/crawl-rules";

export const queueConfigSchema = z.strictObject({
  concurrency: z.number().int().min(1),
  retryLimit: z.number().int().min(0),
  retryDelaySeconds: z.number().int().min(0),
  retryBackoff: z.boolean(),
  /** Seconds a job may stay active before pg-boss expires and retries it (pg-boss default 900 when omitted). */
  expireInSeconds: z.number().int().min(1).optional(),
});

export const BUDGET_SERVICES = ["anthropic", "voyage", "dataforseo", "firecrawl", "jina", "openai"] as const;
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
  /** Longest real-time call of this task (default `callTimeoutSeconds`); a short one for a check inside a long job. */
  timeoutSeconds: z.number().int().positive().optional(),
  /** Model decision of the task (e.g. after the model comparison), shown on the settings page. */
  decision: z.strictObject({ status: z.enum(["provisional", "decided"]), note: z.string().trim().min(1) }).optional(),
});

const imageTaskSchema = z.strictObject({
  model: z.string().min(1),
  promptVersion: z.number().int().min(1),
  size: z.literal("1536x1024"),
  quality: z.enum(["low", "medium", "high"]),
  /** Longest image edit call (an edit of 1536 x 1024 takes minutes); the job expiry of `images.place` must cover it. */
  timeoutSeconds: z.number().int().positive(),
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
    /** Image generation tasks (OpenAI `v1/images/edits`), priced per image and quality. */
    imageTasks: z.record(z.string(), imageTaskSchema),
    pricesEurPerImage: z.record(
      z.string(),
      z.strictObject({ high: z.number().nonnegative(), medium: z.number().nonnegative(), low: z.number().nonnegative() }),
    ),
    cacheWriteFactor: z.number().nonnegative(),
    /** Timeout of one real-time model call (no SDK retry; the job retry resends, SEC-2). */
    callTimeoutSeconds: z.number().int().positive(),
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
    for (const [name, task] of Object.entries(models.imageTasks)) {
      if (!(task.model in models.pricesEurPerImage)) {
        ctx.addIssue({ code: "custom", path: ["imageTasks", name, "model"], message: `no price for model ${task.model}` });
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

const coastSectionSchema = z.strictObject({ key: configKey, names: namesSchema, polygon: polygonSchema });

const iso2 = z.string().regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 alpha-2 code");
const languageCode = z.string().regex(/^[a-z]{2,3}$/, "must be an ISO 639 language code");
const subdivisionKey = z.string().regex(/^[A-Z]{2}(-[A-Z0-9]+)*$/, "must be an ISO 3166-2 style key (e.g. GR-L)");
const seasonSchema = z.strictObject({
  fromMonth: z.number().int().min(1).max(12),
  toMonth: z.number().int().min(1).max(12),
});
const subdivisionStatus = z.enum(["active", "excluded"]);

/** The coast sections of a subdivision must have unique keys. */
const coastSectionsSchema = z.array(coastSectionSchema).superRefine((sections, ctx) => {
  const keys = sections.map((s) => s.key);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) ctx.addIssue({ code: "custom", message: `duplicate coast section key ${dup}` });
});

/** Which unit is a Landesteil, per country, and how the OSM units are split, merged, added or left out (spec 14). */
export const subdivisionsConfigSchema = z
  .strictObject({
    /** IHO sea areas counted as Mediterranean (Marine Regions ids); the Sea of Marmara is not among them. */
    mediterranean: z.strictObject({ marineRegionsMrgids: z.array(z.number().int().positive()).min(1) }),
    countries: z.record(
      iso2,
      z.strictObject({
        /** OSM admin_level of the first-level units, or `whole` when the country is one unit. */
        firstLevel: z.union([z.number().int().min(2).max(10), z.literal("whole")]),
        secondLevel: z.number().int().min(2).max(10).optional(),
        sourceLanguages: z.array(languageCode).min(1),
        season: seasonSchema,
        cycleDays: z.number().int().min(1),
        status: subdivisionStatus.optional(),
        statusReason: z.string().trim().min(1).optional(),
      }),
    ),
    /** A first-level unit split into groups of second-level units (by Wikidata id). */
    split: z.array(
      z.strictObject({
        parentKey: subdivisionKey,
        groups: z
          .array(
            z.strictObject({
              key: subdivisionKey,
              names: namesSchema,
              memberWikidataIds: z.array(wikidataQid).min(1),
            }),
          )
          .min(2),
      }),
    ),
    wholeCountry: z.array(iso2),
    /** A unit that is no first-level unit of its country (OSM relation), cut out of another country. */
    extra: z.array(
      z.strictObject({
        key: subdivisionKey,
        country: iso2,
        osmRelationId: z.number().int().positive(),
        cutFrom: iso2,
        names: namesSchema,
      }),
    ),
    /** Several units merged into one subdivision. */
    merge: z.array(
      z.strictObject({
        key: subdivisionKey,
        memberKeys: z.array(subdivisionKey).min(2),
        names: namesSchema,
      }),
    ),
    /** Unit keys that touch the IHO polygon only via canals or river mouths. */
    notMediterranean: z.array(subdivisionKey),
    /** OSM relation id to key, for units without or with a wrong ISO 3166-2 tag. */
    keyOverrides: z.record(z.string().regex(/^[1-9][0-9]*$/, "must be an OSM relation id"), subdivisionKey),
    /**
     * Keys of the configured areas (Reviere) before spec 14, each with the subdivision to name instead when a run,
     * script or API call still passes one.
     */
    retiredAreaKeys: z.record(configKey, subdivisionKey),
    /** Per subdivision key: deviations from its country's settings. */
    overrides: z.record(
      subdivisionKey,
      z.strictObject({
        status: subdivisionStatus.optional(),
        statusReason: z.string().trim().min(1).optional(),
        sourceLanguages: z.array(languageCode).min(1).optional(),
        season: seasonSchema.optional(),
        cycleDays: z.number().int().min(1).optional(),
        coastSections: coastSectionsSchema.optional(),
      }),
    ),
  })
  .superRefine((config, ctx) => {
    const groupKeys = new Set(config.split.flatMap((s) => s.groups.map((g) => g.key)));
    config.merge.forEach((m, i) => {
      if (groupKeys.has(m.key)) {
        ctx.addIssue({ code: "custom", path: ["merge", i, "key"], message: `merge key ${m.key} is also a split group key` });
      }
    });
    config.wholeCountry.forEach((iso, i) => {
      if (!(iso in config.countries)) ctx.addIssue({ code: "custom", path: ["wholeCountry", i], message: `unknown country ${iso}` });
    });
    config.extra.forEach((e, i) => {
      for (const iso of [e.country, e.cutFrom]) {
        if (!(iso in config.countries)) ctx.addIssue({ code: "custom", path: ["extra", i], message: `unknown country ${iso}` });
      }
    });
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
    /** Relations with more member points are skipped: assembling the Aegean Sea (678,000 points) exhausted the database. */
    maxRelationPoints: z.number().int().positive(),
  }),
  /** Marine Regions WFS (IHO sea areas, spec 14). */
  marineRegions: z.strictObject({
    endpoint: z.url(),
    timeoutMs: z.number().int().positive(),
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
    featureCodes: z.record(z.string().regex(/^[A-Z0-9]+$/), geoObjectType),
    refreshDays: z.number().int().positive(),
  }),
  bboxBufferKm: z.number().nonnegative(),
  landBufferKm: z.number().nonnegative(),
  coastDistanceM: z.number().positive(),
  /** The coarse gazetteer's features per country (plan 14b): OSM place values kept as towns, minimum areas, coast distance. */
  coarse: z.strictObject({
    placeTypes: z.array(z.string().regex(/^[a-z_]+$/)).min(1),
    islandMinAreaKm2: z.number().nonnegative(),
    gulfMinAreaKm2: z.number().nonnegative(),
    coastDistanceKm: z.number().positive(),
  }),
  /** A gazetteer POI counts as a place's POI (and is kept at import) within this distance of the coast (spec 16). */
  poiCoastDistanceKm: z.number().positive(),
  /** Radius around an object's centroid within which a subdivision's land counts for the assignment (spec 14). */
  subdivisionRadiusM: z.number().positive(),
  islandParentBufferM: z.number().nonnegative(),
  coastSectionMaxAreaKm2: z.number().positive(),
  merge: z.strictObject({
    trigramMin: z.number().min(0).max(1),
    uncertainTrigramMin: z.number().min(0).max(1),
    distanceM: distanceMSchema,
    uncertainDistanceFactor: z.number().min(1),
    wikidataLinkDistanceM: z.number().positive(),
    geonamesNewObjectRadiusM: z.number().positive(),
    /** Spec 16: two selected highlights of a category with similar names closer than this get a pair task. */
    highlightPairM: z.number().positive(),
    /** Decides a pair of geo objects without a person where the sources make it clear (`autoPairDecision`). */
    autoDecidePairs: z.boolean(),
  }),
  noAnchoringKinds: z.array(z.enum(restrictedKindEnum.enumValues)),
  /**
   * OSM tag values that make a harbour clearly commercial (spec 17 Belegregel `port`): a `port` place whose geo object
   * carries one of them, and no `leisure=marina`, is confirmed by rule `osm_commercial`.
   */
  commercialHarbourTags: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
});

/** `config/fact-schema/active.json`: the fact schema version new facts are written with. */
export const factSchemaConfigSchema = z.strictObject({
  version: z.string().regex(/^v[1-9][0-9]*$/, "must be v<number>"),
});

const share = z.number().min(0).max(1);
const confidence = share;
const meters = z.number().positive();
const positiveInt = z.number().int().positive();

/**
 * `config/geometry.json`: parameters of the geometric computations; any change of a computation's parameters raises
 * `rulesVersion`. `bays` (unnamed-bay detection, spec 04 / ruling M7-P13) writes no computations and is not versioned by it.
 */
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
  bays: z
    .strictObject({
      coastStepM: meters,
      probeOffsetM: meters,
      rayCount: positiveInt,
      rayLengthM: meters,
      minLandDeg: z.number().positive().max(360),
      minAnchorAreaM2: z.number().positive(),
      mergeDistanceM: meters,
      /** A merged cluster wider than this (largest distance between two hits) is split into pieces of at most this span. */
      maxClusterSpanM: meters,
      knownPlaceDistanceM: meters,
      /**
       * A hit single-linked to a known hit and within this distance of a place or known object belongs to that place's
       * own bay and is dropped too (ruling M7-I-R2).
       */
      knownBayDistanceM: meters,
      /** Valid geo objects of these types within `knownPlaceDistanceM` make a hit known (besides places of any status). */
      knownObjectTypes: z.array(geoObjectType).min(1),
      helperNameMaxDistanceM: meters,
      /** Helper-name tiers in priority order: the nearest named object of the first tier with one within reach names the bay. */
      helperNameTypes: z.array(z.array(geoObjectType).min(1)).min(1),
    })
    .refine((b) => b.probeOffsetM < b.rayLengthM, "probeOffsetM must be below rayLengthM")
    .refine((b) => b.mergeDistanceM < b.maxClusterSpanM, "mergeDistanceM must be below maxClusterSpanM")
    .refine(
      (b) => b.maxClusterSpanM <= 2 * b.knownPlaceDistanceM,
      "maxClusterSpanM must be at most twice knownPlaceDistanceM (a created bay must make its whole piece known on a rerun)",
    )
    .refine(
      (b) => b.knownBayDistanceM >= b.knownPlaceDistanceM + b.maxClusterSpanM / 2,
      "knownBayDistanceM must be at least knownPlaceDistanceM + maxClusterSpanM / 2 (a same-pass duplicate's piece must be claimed on a rerun)",
    ),
});

/** `config/restrictions.json`: Natura 2000 sites (site codes) where anchoring is banned. */
export const restrictionsSchema = z.strictObject({
  protectedAreaAnchoringBan: z.array(
    z.string().regex(/^[A-Z]{2}[0-9A-Z]{7}$/, "must be a Natura 2000 site code (two letters, seven characters)"),
  ),
});

/** Pilot and full-operation target of a metric; `direction` says whether the value must reach (min) or stay under (max) it. */
const metricTarget = z.strictObject({
  pilot: z.number().min(0).nullable(),
  full: z.number().min(0).nullable(),
  direction: z.enum(["min", "max"]),
});

/**
 * `config/quality.json`: the M2 spot check (`navilySample`) and the quality measurement of spec 10 (targets,
 * thresholds of the metrics, the Navily comparison, the extrapolation). One source per threshold (ruling M7-P1): the
 * spot check reads the protected threshold and the seabed share from `navily`.
 */
export const qualitySchema = z.strictObject({
  navilySample: z.strictObject({
    /** A Navily spot counts as the same place within this distance. */
    radiusM: meters,
    /** Spec 04: the sample covers 20 places. */
    minPlaces: positiveInt,
    /** Per-sector rates are only reported from this many matched places on (no reconstruction of single spots). */
    minMatchedForSectorRates: positiveInt,
  }),
  /** Spec 10 „Zielwerte“: pilot and full operation per metric (keys of `METRIC_KEYS`). */
  targets: z.strictObject({
    coverage: metricTarget,
    coverage_navily: metricTarget,
    multi_source: metricTarget,
    /** The datendienst Mehrbefund („mindestens 2 Dokumenten“), the acceptance metric (ruling M7-P12). */
    multi_document: metricTarget,
    fact_precision: metricTarget,
    quote_fidelity: metricTarget,
    shelter_confidence: metricTarget,
    route_reconstruction: metricTarget,
    cost_per_place: metricTarget,
    review_minutes_per_100: metricTarget,
  }),
  /** Pilot: „Review-Aufwand für den zweiten Lauf unter 60 Minuten“. */
  secondRunReviewMinutesMax: z.number().positive(),
  /** Pilot success criteria with a count: „Routen-Rekonstruktion an mindestens 3 Törnberichten“, „10 von 10 Änderungen“. */
  pilotCriteria: z.strictObject({ minTripReports: positiveInt, revisitChanges: positiveInt }),
  /** A review duration counts at most this long (a tab left open must not skew the effort). */
  reviewDurationCapMinutes: z.number().positive(),
  /** „Anteil Orte mit Beobachtung < 18 Monate“. */
  recentObservationMonths: positiveInt,
  /** Shelter confidence: a text fact confirms a computed sector within this deviation. */
  shelterConfirmTolerance: share,
  /** Tile size check: places per tile, target range. */
  placesPerTile: z
    .strictObject({ min: z.number().int().min(0), max: positiveInt })
    .refine((r) => r.min <= r.max, "min must not exceed max"),
  /** „im Pilot 50 Orte, je weiterem Revier 20–30“. */
  comparisonSet: z
    .strictObject({ pilotSize: positiveInt, perSubdivisionMin: positiveInt, perSubdivisionMax: positiveInt })
    .refine((s) => s.perSubdivisionMin <= s.perSubdivisionMax, "perSubdivisionMin must not exceed perSubdivisionMax"),
  /** The Navily comparison assistant (matching, normalisation of the compared values). */
  navily: z.strictObject({
    /** No Navily spot farther than this is matched to a place. */
    maxRadiusM: meters,
    /** Name similarity from which a spot matches within `maxRadiusM`. */
    nameStrongMin: share,
    /** Name similarity from which a spot matches within `nameRadiusM`. */
    nameMin: share,
    nameRadiusM: meters,
    /** A spot this close matches without a name. */
    nearRadiusM: meters,
    /** Positions within this distance count as the same. */
    positionToleranceM: meters,
    /** Own shelter at or above this value counts as a protected sector. */
    protectedThreshold: share,
    /** Own seabed types below this share do not count as the place's seabed. */
    seabedShareMin: share,
    /** Depths are compared rounded to this step. */
    depthStepM: z.number().positive(),
    /** `checked_by` of machine-accepted proposals. */
    proposalVersion: z.string().min(1).max(120),
  }),
  /** Mediterranean extrapolation of the cost report; `placesPerSubdivision` null = measured in the pilot. */
  extrapolation: z
    .strictObject({ subdivisionsMin: positiveInt, subdivisionsMax: positiveInt, placesPerSubdivision: positiveInt.nullable() })
    .refine((e) => e.subdivisionsMin <= e.subdivisionsMax, "subdivisionsMin must not exceed subdivisionsMax"),
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

/** Wikidata sitelink counts (importance signal, ruling M5-P1). */
export const sitelinksDatasetSchema = z.strictObject({
  /** A count fetched within this many days is reused without a call. */
  reuseDays: z.number().int().positive(),
});

/** `config/datasets.json`: external datasets of the geometry stage. */
export const datasetsSchema = z.strictObject({
  bathymetry: bathymetryDatasetSchema,
  seabed: seabedDatasetSchema,
  humanActivities: humanActivitiesDatasetSchema,
  vesselDensity: vesselDensityDatasetSchema,
  cables: cablesDatasetSchema,
  roads: roadsDatasetSchema,
  sitelinks: sitelinksDatasetSchema,
  /** Margin around an area's box for every dataset request, in km. */
  bufferKm: z.number().nonnegative(),
});

const docType = z.enum(DOC_TYPES);
const changeRate = z.enum(changeRateEnum.enumValues);
const eur = z.number().nonnegative();
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
    /** Further attempts of one search after a transient task error (40101) before the search is given up. */
    taskRetries: z.number().int().nonnegative(),
    /** Pause before the first further attempt; it doubles with each attempt. */
    taskRetryDelayMs: z.number().int().nonnegative(),
  }),
  templates: z.strictObject({ area: z.array(queryTemplateSchema), tile: z.array(queryTemplateSchema) }),
  /** A named bay becomes a tile query with an anchor area of at least this size or this many Wikidata names. */
  bay: z.strictObject({ minAnchorAreaM2: z.number().positive(), minWikidataNames: positiveInt }),
  /**
   * Finding the website of a marina or port by Google search (spec 15 C): the templates (`{name}`, optionally
   * `{island}`: the island the place lies on; a template whose name or island is missing in its language is skipped),
   * the hits checked per place, the days before a place without website is searched again, the model's confidence a hit
   * needs, and the crawl rules of a new `place_website` source (depth, pages per start URL).
   */
  placeWebsite: z.strictObject({
    templates: z.array(queryTemplateSchema),
    maxResults: positiveInt,
    retryDays: positiveInt,
    minConfidence: z.number().min(0).max(1),
    crawl: z.strictObject({ maxDepth: z.number().int().min(0).max(10), maxPagesPerStartUrl: positiveInt }),
  }),
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
    /** The disambiguation sees at most this many characters of the chunk around the name. */
    disambiguationContextChars: positiveInt,
    /** Tile ring around the tiles a document touches; 2 is a test switch. */
    neighbourRing: z.union([z.literal(1), z.literal(2)]),
    versionsPerJob: positiveInt,
    /** Object types matched against the whole text first, to find the tiles a document touches. */
    prepassTypes: z.array(geoObjectType).min(1),
    /** Normalized words that never form a mention on their own. */
    stopNames: z.array(z.string().min(1).refine((n) => n === normalizeName(n), "must be normalized (normalizeName)")),
    /**
     * Ordinary words that are also place names (normalized, per language; ruling M4-E-R3): a one-word hit on one of
     * them is never sure without an affix and goes to the disambiguation.
     */
    commonWords: z.record(
      z.string().regex(/^[a-z]{2}$/, "ISO 639-1 language code"),
      z.array(z.string().min(1).refine((n) => n === normalizeName(n), "must be normalized (normalizeName)")),
    ),
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
  /** At most this many stops of a route section are looked at (the prompt says so too). */
  routeMaxStops: positiveInt,
  /** Limits of a route stop, enforced when it is stored and stated in the prompt: name length, top of the Beaufort scale. */
  routeStop: z.strictObject({ nameMaxChars: positiveInt, maxBeaufort: positiveInt }),
  /**
   * Longest proper name a highlight's `poi_name` may carry, enforced when facts are stored and stated in the facts
   * prompt (the fact schema's `properName` caps every stored name too).
   */
  properNameMaxChars: positiveInt,
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
  /** M4 acceptance (`npm run check:texts`): more than this share of the match's mentions without a model call. */
  acceptance: z.strictObject({ minDeterministicShare: share }),
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

/** `config/consolidation/active.json`: the rules version `AppConfig.consolidation` holds. */
export const consolidationActiveSchema = z.strictObject({
  version: z.string().regex(/^v[1-9][0-9]*$/, "must be v<number>"),
});

const positive = z.number().positive();
const ascending = (values: number[]) => values.every((v, i) => i === 0 || v > values[i - 1]!);
/** Positive weights summing to 1 (a weighted mean that needs no normalisation). */
const weightSet = <K extends string>(keys: readonly K[]) =>
  z
    .record(z.enum(keys as readonly [K, ...K[]]), positive)
    .refine((w) => Math.abs(Object.values<number>(w).reduce((a, b) => a + b, 0) - 1) < 1e-9, "weights must sum to 1");
const sentenceRange = z
  .tuple([positiveInt, positiveInt])
  .refine(([min, max]) => min <= max, "minimum sentences must not exceed the maximum");
const month = z.number().int().min(1).max(12);
const attributePattern = z.string().regex(/^[a-z_]+(\.([A-Za-z_]+|\*))?$/, "must be an attribute key or <prefix>.*");

/**
 * `config/consolidation/<version>.json`: parameters of the consolidation rules (spec 07); the file name is the
 * rules version (`rules_version` of every profile). A changed parameter is a new version file.
 */
export const consolidationSchema = z.strictObject({
  recency: z.strictObject({ halfLifeYears: positive }),
  /** Decimal places of every computed number in a profile. */
  precision: z.number().int().min(0).max(10),
  /** Source weight of inputs that have no source. */
  weights: z.strictObject({ computed: share, review: share, observed: share, poi: share }),
  poiConfidence: confidence,
  confidence: z
    .strictObject({
      secondSourceBonus: share,
      cap: confidence,
      review: confidence,
      classes: z.tuple([
        z.strictObject({ name: z.literal("high"), min: confidence }),
        z.strictObject({ name: z.literal("medium"), min: confidence }),
        z.strictObject({ name: z.literal("low"), min: z.literal(0) }),
      ]),
    })
    .refine((c) => c.classes[0].min > c.classes[1].min && c.classes[1].min > 0, "class minima must descend to low = 0"),
  conflict: z.strictObject({ minRatio: z.number().gt(1) }),
  /**
   * `additiveLists`: safety lists whose added entries are always `changed`, judged per entry and never held back as
   * uncertain (ruling M5-F-R3 I-3, "Jede Nennung gilt"); removals and changed entries go through the uncertain gate.
   */
  change: z.strictObject({ minIndependent: positiveInt, strongWeight: share, additiveLists: z.array(attributePattern) }),
  expiry: z.strictObject({ cycles: positiveInt, defaultCycleDays: positiveInt }),
  rules: z.strictObject({
    shelter: z.strictObject({
      maxCorrection: share,
      harbourFloor: share,
      harbourKinds: z.array(z.enum(placeKindEnum.enumValues)).min(1),
      openSideMinConfidence: confidence,
      openSideMaxValue: share,
      harbourDefaultConfidence: confidence,
    }),
    swell_protection: z.strictObject({ textMinConfidence: confidence }),
    bathymetry: z.strictObject({ textMinConfidence: confidence, weakRasterConfidence: confidence }),
    /** Object attributes picked on `present` alone, their other fields filled per field (ruling M5-C-R2 I-1). */
    latest_observation: z.strictObject({ presence: z.array(attributePattern) }),
    /** `fieldwise`: object attributes merged field by field, each field the latest input carrying it (M5-C-R2 I-1). */
    default: z.strictObject({ latestMinConfidence: confidence, fieldwise: z.array(attributePattern) }),
    /** An input confirms a weighted mean when it lies closer than `agreeWithin` to it (ruling M5-C-R1 (4)). */
    area_weighted: z.strictObject({ agreeWithin: share }),
    highlight: z.strictObject({ maxNames: positiveInt, poiRadiusM: meters }),
    /** Identity key of a list entry per attribute merged by `union`; [] = the element itself (ruling M5-P3). */
    union: z.strictObject({ keys: z.record(attributePattern, z.array(z.string().min(1))) }),
  }),
  profileConfidence: weightSet(["shelter", "depth", "seabed", "exclude"]),
  /** The attributes (keys or `<prefix>.*`) whose confidences each group of `profileConfidence` averages. */
  profileConfidenceGroups: z.strictObject({
    shelter: z.array(attributePattern).min(1),
    depth: z.array(attributePattern).min(1),
    seabed: z.array(attributePattern).min(1),
    exclude: z.array(attributePattern).min(1),
  }),
  quietness: z.strictObject({
    settlementFullM: meters,
    roadFullM: meters,
    ferryLaneRadiusM: meters,
    ferryLaneValue: share,
    occupancyMonths: z.array(month).min(1),
    occupancy: z.strictObject({ empty: share, moderate: share, full: share }),
    text: z.strictObject({ quiet: share, moderate: share, busy: share, noisy: share }),
    ferryTraffic: z.strictObject({ none: share, low: share, moderate: share, high: share }),
    weights: weightSet(["settlement", "road", "occupancy", "text", "ferry"]),
    /** Known parts a quietness value needs (ruling M5-E-R2); fewer → no value, a gap. */
    minParts: z.number().int().min(1).max(5),
  }),
  importance: z
    .strictObject({
      sitelinksPerPoint: positive,
      maxSitelinkPoints: z.number().nonnegative(),
      categoryBonus: z.strictObject(
        Object.fromEntries(poiCategoryEnum.enumValues.map((c) => [c, z.number().nonnegative()])) as Record<
          (typeof poiCategoryEnum.enumValues)[number],
          z.ZodNumber
        >,
      ),
      /** Score limits between the importance levels 1–5. */
      thresholds: z.array(z.number()).length(4),
      /** Radius of meaning per importance level, nautical miles. */
      radiusNm: z.array(positive).length(5),
      maxSpotIds: positiveInt,
      /** Importance bonus per OSM tag (`<key>=<value>`) or Wikidata class (`wikidata:<Qid>`); optional: v1 predates it. */
      tagBonus: z.record(z.string(), z.number().nonnegative()).optional(),
    })
    .refine((i) => ascending(i.thresholds), "importance thresholds must ascend")
    .refine((i) => ascending(i.radiusNm), "importance radii must ascend"),
  /** Highlight selection per place (spec 16); optional: v1 predates it. */
  highlights: z
    .strictObject({
      maxPerCategory: positiveInt,
      /** Reach in km per importance level 1–5 (index = importance − 1). */
      reachKm: z.array(positive).length(5),
      /** Weight per importance level 1–5 for the highlight level of a place. */
      levelWeights: z.array(z.number().nonnegative()).length(5),
      /** Weighted-sum limits between the levels none / some / many. */
      levelThresholds: z.array(z.number()).length(2),
      /** Importance given to a POI that a text names but no source rates. */
      textNameImportance: z.number().int().min(1).max(5),
    })
    .refine((h) => ascending(h.levelThresholds), "highlight level thresholds must ascend")
    .optional(),
  severity: z.strictObject({
    safety: z.array(attributePattern),
    /** A shelter sector changing by more than this is a safety change. */
    shelterDelta: share,
    notable: z.array(attributePattern),
  }),
  gaps: z.strictObject({
    /** Attributes whose absence is no gap, per place kind. */
    ignore: z.partialRecord(z.enum(placeKindEnum.enumValues), z.array(attributePattern)),
  }),
  followup: z.strictObject({ minDocuments: positiveInt, cooldownDays: positiveInt, maxPlacesPerRun: positiveInt }),
  summary: z.strictObject({
    levels: z.array(z.enum(["place", "poi"])).min(1),
    sentences: z.strictObject({ place: sentenceRange, poi: sentenceRange }),
    maxAttempts: positiveInt,
    lowConfidence: confidence,
  }),
});

const metreRange = z
  .tuple([positive, positive])
  .refine(([min, max]) => min < max, "range must be [min, max] with min < max");
// `<file>#<JSON pointer>` with `*` for every list entry, e.g. `spots.json#/spots/*/name`.
const contractField = z
  .string()
  .regex(/^[a-z-]+\.(json|geojson)#\/\S*$/, "must be <contract file>#<JSON pointer>")
  .refine((f) => (CONTRACT_FILES as readonly string[]).includes(f.split("#")[0]!), "must name a contract file");

/** `config/delivery.json`: package build, validation thresholds, licences and API caching (spec 08). */
export const deliverySchema = z.strictObject({
  /** Contract version the build writes. */
  schemaVersion: z.literal(SCHEMA_VERSION),
  build: z.strictObject({
    /**
     * `lock_timeout` while a build waits for its area lock, milliseconds: a build waiting longer fails and its job is
     * retried, so waiters never hold their pool connections for good (see docs/runbook.md, "Pakete bauen").
     */
    lockTimeoutMs: positiveInt,
  }),
  spots: z.strictObject({
    /** Place statuses delivered as spots (excluded spots are delivered with `exclude.excluded`). */
    statuses: z.array(z.enum(placeStatusEnum.enumValues)).min(1),
    maxSources: positiveInt,
    /** Name of an excluded spot without a valid name: it is still delivered, so the app knows (ruling M6-C-R1). */
    excludedFallbackName: z.string().trim().min(1),
  }),
  coast: z.strictObject({
    /** Margin around the area box, nautical miles. */
    marginNm: positive,
    simplifyToleranceM: positive,
    /** `source` of land and coastline features. */
    source: z.string().trim().min(1),
    /** `source` of a restricted-area feature without its own `source_ref` (ruling M6-P25). */
    restrictedSourceDefault: z.string().trim().min(1),
  }),
  regions: z.strictObject({
    /** Geo object types delivered as regions. */
    types: z.array(geoObjectType).min(1),
    /** Radius of a region known only as a point, nautical miles. */
    pointRadiusNm: positive,
    /** A spot this close to a region polygon belongs to it (bays of an island), nautical miles (ruling M6-C-R1). */
    memberMarginNm: positive,
    simplifyToleranceM: positive,
    character: z
      .strictObject({ meltemiHigh: share, meltemiLow: share })
      .refine((c) => c.meltemiLow < c.meltemiHigh, "meltemiLow must be below meltemiHigh"),
  }),
  weather: z.strictObject({
    regionBufferNm: positive,
    /**
     * A region polygon holds water when at least this share of its area is not land: its point then lies inside it,
     * otherwise (an island) in its buffer (ruling M6-C-R2).
     */
    regionMinWaterShare: share,
    capeOffsetNm: positive,
    capeLandRadiusM: positive,
  }),
  /** Radius delivery (spec 18): radius = `nmPerDay × days × returnFactor`, `days` within `minDays`–`maxDays`. */
  radius: z
    .strictObject({
      nmPerDay: positive,
      returnFactor: positive,
      minDays: positiveInt,
      maxDays: positiveInt,
    })
    .refine((r) => r.minDays <= r.maxDays, "minDays must not exceed maxDays")
    // 28 is the contract's ceiling (manifest scope `days`); a longer trip would make packages the contract refuses
    .refine((r) => r.maxDays <= RADIUS_MAX_DAYS, { message: `maxDays must not exceed the contract's ${RADIUS_MAX_DAYS}`, path: ["maxDays"] }),
  /** `popularity` is normalised within this distance of each place, across subdivisions (spec 18), nautical miles. */
  popularity: z.strictObject({ neighbourhoodNm: positive }),
  highlights: z.strictObject({ maxSpotIds: positiveInt }),
  validation: z.strictObject({
    maxWaterDistanceNm: positive,
    spotDuplicateM: positive,
    highlightDuplicateM: positive,
    maxDraftM: metreRange,
    maxLengthM: metreRange,
    harbourMinShelter: share,
    /**
     * Shelter provenance that lets a port or marina below `harbourMinShelter` pass (Teil B "text oder observed"; a
     * review decision counts too, ruling M6-D-R2).
     */
    harbourShelterSources: z.array(z.enum(PROVENANCE_SOURCES)).min(1),
    /** Teil B "kein Textfeld mit mehr als 15 Wörtern wörtlich aus einer Quelle": the longest copied run allowed. */
    maxCopiedWords: z.number().int().min(COPY_SHINGLE_WORDS),
    /** Copy checks (`text_shingles` queries) running at once. */
    copyCheckConcurrency: positiveInt,
    /** Below this `score.confidence` the summary must carry `lowConfidenceNote`. */
    lowConfidence: confidence,
    lowConfidenceNote: z.string().trim().min(1),
  }),
  severity: z.strictObject({ shelterDelta: share }),
  /**
   * Domains whose content never leaves Periplus (Navily, Google): a domain (and its subdomains) or `label.*` for that
   * registrable label on any ICANN public suffix (`google.*`, SEC-4).
   */
  forbiddenDomains: z.array(z.union([domainName, z.string().regex(/^[a-z0-9-]+\.\*$/, "must be label.*")])).min(1),
  licenses: z.array(
    z.strictObject({
      name: z.string().trim().min(1),
      attribution: z.string().trim().min(1),
      url: z.url(),
      files: z.array(z.enum(CONTRACT_FILES)),
      fields: z.array(contractField),
    }),
  ),
  api: z.strictObject({ cacheMaxAgeSeconds: z.number().int().nonnegative() }),
  /**
   * Confirmation by evidence (spec 17 „Bestätigung nach Beleg“): which source types confirm a place alone, which count
   * as one of `pairMinDomains` documents of distinct domains, whose own website confirms its marina, and which place
   * attributes (exact keys or `prefix.*`) are a berth fact. Route stops of trip reports count when `routeStops`.
   */
  confirmation: z
    .strictObject({
      aloneTypes: z.array(z.enum(DOC_TYPES)),
      pairTypes: z.array(z.enum(DOC_TYPES)),
      pairMinDomains: z.number().int().min(2),
      ownSiteTypes: z.array(z.enum(DOC_TYPES)),
      berthAttributes: z.array(z.string().regex(/^[a-z_]+(\.[a-zA-Z_]+)*(\.\*)?$/, "must be an attribute key or prefix.*")).min(1),
      routeStops: z.boolean(),
    })
    .refine((c) => !c.ownSiteTypes.some((t) => c.aloneTypes.includes(t) || c.pairTypes.includes(t)), "ownSiteTypes count only for the bound place"),
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
const geoObjectTypeSchema = z.enum(geoObjectTypeEnum.enumValues);

/** The member and boundary-point types of a Revier-Bot file. */
export const botType = z.enum(["harbour", "island", "islet", "settlement", "bay", "gulf", "cape", "strait", "channel", "archipelago"]);
export type BotType = z.infer<typeof botType>;

/** `config/areas.json`: import of the Revier-Bot delivery (spec 14). */
export const areasConfigSchema = z.strictObject({
  minMembers: z.number().int().min(1),
  polygon: z.strictObject({
    bufferNm: z.number().positive(),
    concaveRatio: z.number().min(0).max(1),
    inlandCutM: z.number().min(0),
    gulfCoverShare: z.number().min(0).max(1),
  }),
  neighbourRing: z.number().int().min(0),
  /** Bot member type to the geo object types it may resolve to; every bot type, no other key (a typo fails at load). */
  memberTypes: z.record(botType, z.array(geoObjectTypeSchema).min(1)),
  /** Legacy area key to bot key. */
  aliases: z.record(z.string().min(1), z.string().min(1)),
});

export type SubdivisionsConfig = z.infer<typeof subdivisionsConfigSchema>;
export type AreasConfig = z.infer<typeof areasConfigSchema>;
export type CategoriesConfig = z.infer<typeof categoriesSchema>;
export type GazetteerConfig = z.infer<typeof gazetteerSchema>;
export type ConsolidationConfig = z.infer<typeof consolidationSchema>;
export type DeliveryConfig = z.infer<typeof deliverySchema>;
export type ImagesConfig = z.infer<typeof imagesSchema>;
export type ImagerySource = keyof ImagesConfig["sources"];
export type ImageryLight = z.infer<typeof imageryLightSchema>;
export type ZoomLevel = keyof ImagesConfig["camera"]["zooms"];
/** A rules version's parameters with its version (the file name). */
export type VersionedConsolidationConfig = ConsolidationConfig & { version: string };
export type AppConfig = {
  queues: Record<string, QueueConfig>;
  budgets: Record<BudgetService, { dailyEur: number }>;
  models: ModelsConfig;
  subdivisions: SubdivisionsConfig;
  areas: AreasConfig;
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
  /** The active consolidation rules version (`config/consolidation/active.json`). */
  consolidation: VersionedConsolidationConfig;
  delivery: DeliveryConfig;
  images: ImagesConfig;
  research: ResearchConfig;
};

const imageryLightSchema = z.enum(["midday", "evening"]);
const imageCountries = z.array(z.string().length(2)).or(z.literal("*"));
const imageWmsSourceSchema = z.strictObject({
  kind: z.literal("wms"),
  countries: imageCountries,
  url: z.url(),
  layer: z.string().min(1),
  format: z.string().min(1),
  resolutionM: z.number().positive(),
  maxRequestPx: z.number().int().positive(),
  watermarked: z.boolean(),
  license: z.string().min(1),
  attribution: z.string().min(1),
  acquiredAt: z.iso.date().nullable(),
  timeoutSeconds: z.number().int().positive(),
  ratePerMinute: z.number().int().positive(),
});
const imageCogSourceSchema = z.strictObject({
  kind: z.literal("cog"),
  countries: imageCountries,
  urlTemplate: z.string().includes("{name}"),
  resolutionM: z.number().positive(),
  license: z.string().min(1),
  attribution: z.string().min(1),
  acquiredAt: z.iso.date().nullable(),
  timeoutSeconds: z.number().int().positive(),
  ratePerMinute: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
});
const sceneTextSchema = z.strictObject({ en: z.string().min(1), de: z.string().min(1) });
const zoomSchema = z.strictObject({ heightM: z.number().positive() });
const perKind = <T extends z.ZodType>(value: T) =>
  z.strictObject(Object.fromEntries(placeKindEnum.enumValues.map((k) => [k, value])) as Record<PlaceKind, T>);

/** Title images of places (spec 13): imagery sources, terrain window, camera, light, scene wording and checks. */
export const imagesSchema = z.strictObject({
  sources: z.strictObject({
    ktimatologio: imageWmsSourceSchema,
    sentinel2: imageWmsSourceSchema,
    copernicus_dem: imageCogSourceSchema,
  }),
  /** Whether images built on a source are delivered; one switch per source (the cadastre licence is unconfirmed). */
  delivery: z.strictObject({ ktimatologio: z.boolean(), sentinel2: z.boolean(), copernicus_dem: z.boolean() }),
  window: z.strictObject({
    coreSizeM: z.number().positive(),
    wideMarginDeg: z.number().positive(),
    coreGridM: z.number().positive(),
    wideGridM: z.number().positive(),
    wideSinkM: z.number().nonnegative(),
    whiteThreshold: z.number().int().min(0).max(255),
  }),
  camera: z.strictObject({
    tiltDeg: z.number().positive().max(89),
    fovDeg: z.number().positive().max(179),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    rotateStepDeg: z.number().int().min(1).max(180),
    defaultZoom: z.enum(["z1", "z2", "z3"]),
    zooms: z.strictObject({ z1: zoomSchema, z2: zoomSchema, z3: zoomSchema }),
    /**
     * Version of the camera rules in code (`render-plan.ts`: target, rotation) and of their parameters here; part of
     * the generation key, so a bump generates every image again. `camera-1` was the centre as target (implicit).
     */
    rulesVersion: z.string().min(1),
  }),
  render: z.strictObject({
    maxSourcePixelOnScreen: z.number().positive(),
    rendererVersion: z.string().min(1),
    timeoutSeconds: z.number().int().positive(),
  }),
  light: z.strictObject({
    townRadiusM: z.number().positive(),
    townPlaces: z.array(z.string().min(1)),
    /** Light of an anchorage or mooring field within `townRadiusM` of a place in `townPlaces`. */
    nearTown: imageryLightSchema,
    byKind: perKind(imageryLightSchema),
  }),
  scene: z.strictObject({
    ...perKind(sceneTextSchema).shape,
    near_town: sceneTextSchema,
  }),
  check: z.strictObject({
    minWaterIoU: z.strictObject({ midday: z.number().min(0).max(1), evening: z.number().min(0).max(1) }),
    maxAttempts: z.number().int().min(1),
    waterColour: z.strictObject({ blueOverRedMin: z.number().nonnegative(), greenTolerance: z.number().nonnegative() }),
  }),
  pipeline: z.strictObject({ maxGenerationsPerRun: z.number().int().positive() }),
  composition: z.strictObject({
    /**
     * Anchorage or mooring field near a town: the camera ground point lies `foregroundM` from the centre of the
     * place, away from the town, so the anchorage is in front and the town behind.
     */
    nearTown: z.strictObject({ foregroundM: z.number().positive() }),
    /**
     * Every other place: the camera looks at the shore ahead (the named cove, else the fetch ray along the view
     * direction) when it is within `maxShoreM`, else at the centre of the place; the target lies far enough inland for
     * the shoreline to run `shoreBelowCentreDeg` below the image centre (8.3° ≈ fov/6, the lower-third line). The
     * automatic title image takes `zoom` when the core imagery allows it. The cove point (the place's `position`)
     * counts only when it lies at least `coveMinDistanceM` from the anchor point.
     */
    openWater: z.strictObject({
      maxShoreM: z.number().positive(),
      shoreBelowCentreDeg: z.number().positive(),
      zoom: z.enum(["z1", "z2", "z3"]),
      coveMinDistanceM: z.number().nonnegative(),
    }),
  }),
  output: z.strictObject({
    jpegQuality: z.number().int().min(1).max(100),
    license: z.string().min(1),
    credit: z.string().min(1),
    altPrefix: z.string().min(1),
  }),
}).refine((v) => v.composition.openWater.shoreBelowCentreDeg < v.camera.fovDeg / 2, {
  message: "composition.openWater.shoreBelowCentreDeg must be below camera.fovDeg / 2 (the bottom edge of the image)",
  path: ["composition", "openWater", "shoreBelowCentreDeg"],
});

const nonEmpty = z.string().trim().min(1);
const botMember = z.object({ name: nonEmpty, type: botType });

/** One area of a bot delivery file `config/area-imports/<CC>.json`; unknown keys (e.g. `countries`) are ignored. */
export const importedAreaSchema = z.object({
  key: nonEmpty,
  names: z.array(z.object({ lang: nonEmpty, name: nonEmpty, preferred: z.boolean() })).min(1),
  subdivisions: z.array(nonEmpty),
  members: z.array(botMember),
  boundaryPoints: z.array(botMember),
  boundary: z.string(),
  related: z.array(z.object({ key: nonEmpty, relation: z.enum(["contains", "within", "overlaps"]) })),
  evidence: z
    .array(
      z.object({
        url: z.url({ protocol: /^https?$/, error: "evidence url must be http(s)" }),
        publisher: z.string(),
        lang: nonEmpty,
        quote: nonEmpty.max(1000),
      }),
    )
    .min(1),
  notes: z.string(),
});

export const areaImportFileSchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/),
    generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    areas: z.array(importedAreaSchema),
  })
  .superRefine((file, ctx) => {
    const keys = new Set<string>();
    for (const [i, area] of file.areas.entries()) {
      if (keys.has(area.key)) ctx.addIssue({ code: "custom", path: ["areas", i, "key"], message: `duplicate key ${area.key}` });
      keys.add(area.key);
    }
    for (const [i, area] of file.areas.entries()) {
      for (const [j, rel] of area.related.entries()) {
        if (!keys.has(rel.key)) {
          ctx.addIssue({ code: "custom", path: ["areas", i, "related", j], message: `related points to unknown key ${rel.key}` });
        }
      }
    }
  });

const researchTemplateSchema = z.strictObject({
  /** `{name}`: the berth's name (required: a query without it would hit pages that name no berth); `{island}`: its island's name. */
  template: z.string().refine((t) => t.includes("{name}"), { error: "template must contain {name}" }),
  lang: z.string().min(1),
});

/** Per-berth research (spec 18): search templates, languages by country, SERP location codes and limits. */
export const researchSchema = z
  .strictObject({
    /** Languages searched per country (ISO 3166-1 alpha-2); `default` applies to every other country. */
    languagesByCountry: z.record(z.string(), z.array(z.string().min(1)).min(1)).refine((m) => "default" in m, {
      error: "languagesByCountry needs a default entry",
    }),
    locationCodes: z.record(z.string().min(1), z.number().int().positive()),
    templates: z.strictObject({
      positive: z.array(researchTemplateSchema).min(1),
      negative: z.array(researchTemplateSchema),
    }),
    maxHitsPerCandidate: z.number().int().positive(),
    refetchDays: z.number().int().positive(),
    assessWords: z.number().int().positive(),
    /** Domains whose hits are not taken over; `label.*` skips that registrable label on every public suffix (`tripadvisor.*`). */
    skipDomains: z.array(z.string().min(1)),
    /** The source created for a research hit page (domain without a source). */
    source: z.strictObject({ weight: z.number().min(0).max(1), ratePerMinute: z.number().min(1).max(120) }),
    /** Extraction per page and place (plan N2). */
    extraction: z.strictObject({
      factSchema: z.string().refine((v) => v in FACT_SCHEMAS, { error: "unknown fact schema version" }),
      placeRadiusKm: z.number().positive(),
      maxUnitWords: z.number().int().positive(),
      windowWords: z.number().int().positive(),
      maxSharedWords: z.number().int().positive(),
      routeMaxStops: z.number().int().positive(),
      /** A failed research unit is planned again until it failed this often. */
      maxAttempts: z.number().int().positive(),
      /** How many archived Markdown files the unit planning reads at a time (N3 task 0). */
      markdownReadConcurrency: z.number().int().positive(),
    }),
    /** When a berth counts as confirmed from its signals (plan N2, task 6). */
    confirmation: z.strictObject({
      minIndependentSources: z.number().int().min(1),
      minSignalConfidence: z.number().min(0).max(1),
      positiveKinds: z.array(z.enum(berthSignalKindEnum.enumValues)).min(1),
      negativeKinds: z.array(z.enum(berthSignalKindEnum.enumValues)).min(1),
      countingPageKinds: z.array(z.enum(pageKindEnum.enumValues)).min(1),
      listedAsBerthPageKinds: z.array(z.enum(pageKindEnum.enumValues)),
      officialPageKinds: z.array(z.enum(pageKindEnum.enumValues)),
      /** Place kinds confirmed by an official page plus another domain (marinas, ports); the others by independent sources. */
      officialPlaceKinds: z.array(z.enum(placeKindEnum.enumValues)),
      /** Whether pages linked to a place only by a route corridor count without a search- or name-linked source (ruling: no). */
      corridorAloneConfirms: z.boolean(),
      /** Two sources whose positive quotes share this many consecutive words are copies and count as one (spec 5.6). */
      copyMinSharedWords: z.number().int().positive(),
    }),
    /** The reference gate (plan N3): the subdivision measured, the thresholds compared and the released threshold. */
    gate: z
      .strictObject({
        subdivision: z.string().min(1),
        thresholds: z.array(z.number().int().min(1)).min(1),
        /** Whether the gate is passed and the chosen threshold released for other subdivisions. */
        released: z.boolean(),
        chosenThreshold: z.number().int().min(1).nullable(),
        /** A confirmed place matched to a reference spot of its kind farther than this is a position error (as `quality.navily.positionToleranceM`). */
        maxPositionDeviationM: z.number().positive(),
      })
      .refine((g) => g.thresholds.every((n, i) => i === 0 || n > g.thresholds[i - 1]!), { error: "gate thresholds must be strictly ascending" })
      .refine((g) => !g.released || (g.chosenThreshold !== null && g.thresholds.includes(g.chosenThreshold)), {
        error: "a released gate needs a chosenThreshold among the thresholds",
      }),
    /** Matching route stops to places. */
    discovery: z.strictObject({
      corridorBufferKm: z.number().positive(),
      minNameSimilarity: z.number().min(0).max(1),
      /** A named corridor candidate this similar to the stop (or matching it by name) blocks naming an unnamed bay. */
      vetoSimilarity: z.number().min(0).max(1),
      /** The corridor step applies only to a straight leg prev → next of at most this length. */
      maxLegKm: z.number().positive(),
      /** … and only when the dates of the previous and the next stop are at most this many days apart. */
      maxLegDays: z.number().int().nonnegative(),
      /** A research name stays provisional until route stops of this many registrable domains gave it. */
      corroboratingDomains: z.number().int().positive(),
    }),
  })
  .superRefine((c, ctx) => {
    // a released gate is released for the threshold that delivers: the rule must confirm with the chosen threshold
    if (c.gate.released && c.confirmation.minIndependentSources !== c.gate.chosenThreshold) {
      ctx.addIssue({ code: "custom", path: ["confirmation", "minIndependentSources"], message: "a released gate needs minIndependentSources equal to gate.chosenThreshold" });
    }
    for (const k of c.confirmation.negativeKinds) {
      if (c.confirmation.positiveKinds.includes(k)) {
        ctx.addIssue({ code: "custom", path: ["confirmation", "negativeKinds"], message: `signal kind ${k} is both positive and negative` });
      }
    }
    for (const [country, langs] of Object.entries(c.languagesByCountry)) {
      for (const [i, lang] of langs.entries()) {
        if (!(lang in c.locationCodes)) {
          ctx.addIssue({ code: "custom", path: ["languagesByCountry", country, i], message: `language ${lang} has no locationCodes entry` });
        }
      }
    }
    for (const purpose of ["positive", "negative"] as const) {
      for (const [i, t] of c.templates[purpose].entries()) {
        if (!(t.lang in c.locationCodes)) {
          ctx.addIssue({ code: "custom", path: ["templates", purpose, i, "lang"], message: `language ${t.lang} has no locationCodes entry` });
        }
      }
    }
  });
export type ResearchConfig = z.infer<typeof researchSchema>;
