import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ZodType } from "zod";
import { FACT_SCHEMAS } from "@/config/fact-schema";
import type { FactSchema } from "@/lib/domain/facts/schema-types";
import {
  budgetsSchema,
  categoriesSchema,
  consolidationActiveSchema,
  consolidationSchema,
  datasetsSchema,
  deliverySchema,
  discoverySchema,
  embeddingsSchema,
  extractionSchema,
  factSchemaConfigSchema,
  fetchSchema,
  gazetteerSchema,
  geometrySchema,
  imagesSchema,
  mentionsSchema,
  modelsSchema,
  nameAffixesSchema,
  qualitySchema,
  queuesSchema,
  restrictionsSchema,
  sourceTypesSchema,
  subdivisionsConfigSchema,
  whitelistSchema,
  type AppConfig,
  type SubdivisionsConfig,
  type VersionedConsolidationConfig,
} from "./schemas";

export type {
  AppConfig,
  BudgetService,
  CategoriesConfig,
  ConsolidationConfig,
  DatasetsConfig,
  DeliveryConfig,
  DiscoveryConfig,
  EmbeddingsConfig,
  ExtractionConfig,
  FetchConfig,
  GazetteerConfig,
  GeometryConfig,
  ImageryLight,
  ImagesConfig,
  ImagerySource,
  MentionsConfig,
  ModelEffort,
  ModelsConfig,
  ModelTaskConfig,
  NameAffixesConfig,
  QualityConfig,
  QueueConfig,
  RestrictionsConfig,
  SourceTypesConfig,
  SubdivisionsConfig,
  VersionedConsolidationConfig,
  WhitelistConfig,
  ZoomLevel,
} from "./schemas";

function readJson<T>(dir: string, name: string, schema: ZodType<T>): T {
  return readJsonFile(join(dir, `${name}.json`), schema);
}

function readJsonFile<T>(file: string, schema: ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read config ${file}: ${(error as Error).message}`, { cause: error });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid config ${file}: ${issues}`);
  }
  return parsed.data;
}

/** The keys of the object an attribute's value (or its list entries) is made of; null when it is not an object. */
function entryShapeKeys(value: ZodType): string[] | null {
  let node = value as unknown as { def: { type: string; element?: unknown }; shape?: Record<string, unknown> };
  if (node.def.type === "array") node = node.def.element as typeof node;
  return node.def.type === "object" && node.shape ? Object.keys(node.shape) : null;
}

/**
 * The identity keys of `rules.union.keys` must be fields of the list entries of the attribute in the fact schema
 * (a typo would otherwise merge entries on `undefined` and silently collapse the list).
 */
function checkUnionKeys(file: string, config: ReturnType<typeof consolidationSchema.parse>, factSchema: FactSchema) {
  const defs = Object.values(factSchema.levels).flat();
  for (const [pattern, keys] of Object.entries(config.rules.union.keys)) {
    const prefix = pattern.endsWith(".*") ? pattern.slice(0, -1) : null;
    const matched = defs.filter((d) => (prefix ? d.key.startsWith(prefix) : d.key === pattern));
    if (matched.length === 0) {
      throw new Error(`Invalid config ${file}: rules.union.keys "${pattern}" is no attribute of fact schema ${factSchema.version}`);
    }
    for (const def of matched) {
      const fields = entryShapeKeys(def.value);
      for (const key of keys) {
        if (!fields?.includes(key)) {
          throw new Error(
            `Invalid config ${file}: rules.union.keys "${def.key}" names "${key}", which is no field of its entries in fact schema ${factSchema.version}`,
          );
        }
      }
    }
  }
}

/** Reads and validates `<dir>/consolidation/<version>.json`; the version is the file name. */
function readConsolidation(dir: string, version: string): VersionedConsolidationConfig {
  const { version: valid } = consolidationActiveSchema.parse({ version });
  const config = readJson(dir, `consolidation/${valid}`, consolidationSchema);
  const factVersion = readJson(dir, "fact-schema/active", factSchemaConfigSchema).version;
  const factSchema = FACT_SCHEMAS[factVersion];
  if (!factSchema) throw new Error(`Invalid config ${join(dir, "fact-schema/active.json")}: unknown fact schema version ${factVersion}`);
  checkUnionKeys(join(dir, `consolidation/${valid}.json`), config, factSchema);
  return { ...config, version: valid };
}

/** Seconds a job may stay active before pg-boss expires it when the queue sets no `expireInSeconds`. */
const PG_BOSS_DEFAULT_EXPIRE_SECONDS = 900;
/** Seconds an image job needs beyond the render, the edits and the watermark checks: the water check, the task write. */
const IMAGE_JOB_MARGIN_SECONDS = 120;
const IMAGE_TASK = "generate-place-image";
const IMAGE_CHECK_TASK = "check-place-image";

/**
 * pg-boss must not expire an `images.place` job (and hand it out again beside the one still running) before its worst
 * case ends: the render at `images.render.timeoutSeconds`, then `images.check.maxAttempts` times an image edit at the
 * image task's `timeoutSeconds` plus a watermark check at the check task's `timeoutSeconds` (default
 * `callTimeoutSeconds`), and the margin. The values live in three files, so the check is here, not in a schema.
 */
function checkImageJobExpiry(dir: string, config: Pick<AppConfig, "queues" | "images" | "models">): void {
  const task = config.models.imageTasks[IMAGE_TASK];
  if (!task) throw new Error(`Invalid config ${join(dir, "models.json")}: imageTasks has no ${IMAGE_TASK}`);
  const check = config.models.tasks[IMAGE_CHECK_TASK];
  if (!check) throw new Error(`Invalid config ${join(dir, "models.json")}: tasks has no ${IMAGE_CHECK_TASK}`);
  const checkTimeout = check.timeoutSeconds ?? config.models.callTimeoutSeconds;
  const expire = config.queues["images.place"]?.expireInSeconds ?? PG_BOSS_DEFAULT_EXPIRE_SECONDS;
  const render = config.images.render.timeoutSeconds;
  const attempts = config.images.check.maxAttempts;
  const needed = render + attempts * (task.timeoutSeconds + checkTimeout) + IMAGE_JOB_MARGIN_SECONDS;
  if (expire < needed) {
    throw new Error(
      `Invalid config ${join(dir, "queues.json")}: images.place.expireInSeconds ${expire} is below the worst case of an image job, ` +
        `${needed} s (render ${render} + ${attempts} × (edit ${task.timeoutSeconds} + watermark check ${checkTimeout}) + ${IMAGE_JOB_MARGIN_SECONDS})`,
    );
  }
}

/** Loads and validates all config files; throws on any invalid or missing file. */
export function loadConfig(dir = "config"): AppConfig {
  const config: AppConfig = {
    queues: readJson(dir, "queues", queuesSchema),
    budgets: readJson(dir, "budgets", budgetsSchema),
    models: readJson(dir, "models", modelsSchema),
    subdivisions: readJson(dir, "subdivisions", subdivisionsConfigSchema),
    categories: readJson(dir, "categories", categoriesSchema),
    gazetteer: readJson(dir, "gazetteer", gazetteerSchema),
    factSchema: readJson(dir, "fact-schema/active", factSchemaConfigSchema),
    geometry: readJson(dir, "geometry", geometrySchema),
    restrictions: readJson(dir, "restrictions", restrictionsSchema),
    datasets: readJson(dir, "datasets", datasetsSchema),
    quality: readJson(dir, "quality", qualitySchema),
    sourceTypes: readJson(dir, "source-types", sourceTypesSchema),
    discovery: readJson(dir, "discovery", discoverySchema),
    fetch: readJson(dir, "fetch", fetchSchema),
    embeddings: readJson(dir, "embeddings", embeddingsSchema),
    whitelist: readJson(dir, "sources-whitelist", whitelistSchema),
    mentions: readJson(dir, "mentions", mentionsSchema),
    nameAffixes: readJson(dir, "name-affixes", nameAffixesSchema),
    extraction: readJson(dir, "extraction", extractionSchema),
    consolidation: readConsolidation(dir, readJson(dir, "consolidation/active", consolidationActiveSchema).version),
    delivery: readJson(dir, "delivery", deliverySchema),
    images: readJson(dir, "images", imagesSchema),
  };
  checkImageJobExpiry(dir, config);
  return config;
}

let cached: AppConfig | undefined;
/** Rules versions read by `getConsolidationConfig`, per (dir, version): a version file is immutable once released. */
const consolidationCache = new Map<string, VersionedConsolidationConfig>();

export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/**
 * Parameters of a consolidation rules version (default: the active one), read and validated on demand: an evaluation
 * run compares a candidate version with the active one (ruling M5-P18). Throws for an unknown or malformed version.
 */
export function getConsolidationConfig(version?: string, dir = "config"): VersionedConsolidationConfig {
  if (version === undefined) return getConfig().consolidation;
  if (!consolidationActiveSchema.safeParse({ version }).success) {
    throw new Error(`Unknown consolidation rules version "${version}": must be v<number>`);
  }
  const key = `${dir}\0${version}`;
  let config = consolidationCache.get(key);
  if (!config) {
    config = readConsolidation(dir, version);
    consolidationCache.set(key, config);
  }
  return config;
}

/**
 * The released consolidation rules versions: the `v<number>.json` files in `<dir>/consolidation`, oldest first. Not
 * validated here (`getConsolidationConfig` validates a version when it is read).
 */
export function consolidationVersions(dir = "config"): string[] {
  return readdirSync(join(dir, "consolidation"))
    .map((f) => basename(f, ".json"))
    .filter((v) => consolidationActiveSchema.safeParse({ version: v }).success)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** The configuration of a country (ISO 3166-1 alpha-2) in `config/subdivisions.json`; throws for an unknown one. */
export function countryConfig(iso: string): SubdivisionsConfig["countries"][string] {
  const country = getConfig().subdivisions.countries[iso];
  if (!country) throw new Error(`Unknown country ${iso}`);
  return country;
}
