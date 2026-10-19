import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ZodType } from "zod";
import {
  areaConfigSchema,
  budgetsSchema,
  categoriesSchema,
  datasetsSchema,
  discoverySchema,
  embeddingsSchema,
  factSchemaConfigSchema,
  fetchSchema,
  gazetteerSchema,
  geometrySchema,
  modelsSchema,
  qualitySchema,
  queuesSchema,
  restrictionsSchema,
  sourceTypesSchema,
  whitelistSchema,
  type AppConfig,
  type AreaConfig,
} from "./schemas";

export type {
  AppConfig,
  AreaConfig,
  BudgetService,
  CategoriesConfig,
  DatasetsConfig,
  DiscoveryConfig,
  EmbeddingsConfig,
  FetchConfig,
  GazetteerConfig,
  GeometryConfig,
  QualityConfig,
  QueueConfig,
  RestrictionsConfig,
  SourceTypesConfig,
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
  };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** The configured area with this key; throws for an unknown key. */
export function areaByKey(key: string): AreaConfig {
  const area = getConfig().areas.find((a) => a.key === key);
  if (!area) throw new Error(`Unknown area ${key}`);
  return area;
}
