import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ZodType } from "zod";
import { FACT_SCHEMAS } from "@/config/fact-schema";
import type { FactSchema } from "@/lib/domain/facts/schema-types";
import {
  areaConfigSchema,
  budgetsSchema,
  categoriesSchema,
  consolidationActiveSchema,
  consolidationSchema,
  datasetsSchema,
  discoverySchema,
  embeddingsSchema,
  extractionSchema,
  factSchemaConfigSchema,
  fetchSchema,
  gazetteerSchema,
  geometrySchema,
  mentionsSchema,
  modelsSchema,
  nameAffixesSchema,
  qualitySchema,
  queuesSchema,
  restrictionsSchema,
  sourceTypesSchema,
  whitelistSchema,
  type AppConfig,
  type AreaConfig,
  type VersionedConsolidationConfig,
} from "./schemas";

export type {
  AppConfig,
  AreaConfig,
  BudgetService,
  CategoriesConfig,
  ConsolidationConfig,
  DatasetsConfig,
  DiscoveryConfig,
  EmbeddingsConfig,
  ExtractionConfig,
  FetchConfig,
  GazetteerConfig,
  GeometryConfig,
  MentionsConfig,
  ModelEffort,
  ModelsConfig,
  ModelTaskConfig,
  NameAffixesConfig,
  QualityConfig,
  QueueConfig,
  RestrictionsConfig,
  SourceTypesConfig,
  VersionedConsolidationConfig,
  WhitelistConfig,
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

/** Reads every `<dir>/areas/*.json`; each area's `key` must equal its file name, which makes keys unique. */
function readAreas(dir: string): AreaConfig[] {
  const areasDir = join(dir, "areas");
  const files = readdirSync(areasDir).filter((f) => f.endsWith(".json")).sort();
  return files.map((f) => {
    const file = join(areasDir, f);
    const area = readJsonFile(file, areaConfigSchema);
    const expected = basename(f, ".json");
    if (area.key !== expected) {
      throw new Error(`Invalid config ${file}: key "${area.key}" must equal the file name "${expected}"`);
    }
    return area;
  });
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

/** Loads and validates all config files; throws on any invalid or missing file. */
export function loadConfig(dir = "config"): AppConfig {
  return {
    queues: readJson(dir, "queues", queuesSchema),
    budgets: readJson(dir, "budgets", budgetsSchema),
    models: readJson(dir, "models", modelsSchema),
    areas: readAreas(dir),
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
  };
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

/** The configured area with this key; throws for an unknown key. */
export function areaByKey(key: string): AreaConfig {
  const area = getConfig().areas.find((a) => a.key === key);
  if (!area) throw new Error(`Unknown area ${key}`);
  return area;
}
