import { z } from "zod";

/** An archive write prefix: lower-case segments ending in `/`, e.g. `sim/2026-10-20/`. */
export const S3_WRITE_PREFIX_PATTERN = /^[a-z0-9][a-z0-9/_-]*\/$/;

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_TEST_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  VOYAGE_API_KEY: z.string().min(1).optional(),
  DATAFORSEO_LOGIN: z.string().min(1).optional(),
  DATAFORSEO_PASSWORD: z.string().min(1).optional(),
  JINA_API_KEY: z.string().min(1).optional(),
  FIRECRAWL_API_KEY: z.string().min(1).optional(),
  CONTACT_EMAIL: z.string().min(1),
  /** The Navily spot file, read at runtime only (Grundprinzip 9); unset: comparisons by hand only. */
  NAVILY_SPOTS_PATH: z.string().min(1).optional(),
  /**
   * Archive writes go under this prefix, reads try it first and fall back to the plain key (a simulation's own
   * objects never mix with the recorded ones). Required with `PERIPLUS_SIMULATION`.
   */
  S3_WRITE_PREFIX: z
    .string()
    .regex(S3_WRITE_PREFIX_PATTERN, "must be lower-case segments ending in /, e.g. sim/2026-10-20/")
    .optional(),
  /** Path of the revisit scenario: this process runs a simulated revisit (only against `periplus_sim` or `*_test`). */
  PERIPLUS_SIMULATION: z.string().min(1).optional(),
  /** `playwright`: the worker renders pages in headless Chromium when a crawl rule asks for it; `off`: never. */
  PERIPLUS_RENDERER: z.enum(["playwright", "off"]).default("playwright"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates an env source. Throws a ZodError that names the offending variables;
 * zod issues for these checks never include the input values.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  // Treat empty strings (e.g. `ANTHROPIC_API_KEY=` in .env files) as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  return envSchema.parse(cleaned);
}

let cached: Env | undefined;

/** Memoized env, read from process.env on first call (never at import time). */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
