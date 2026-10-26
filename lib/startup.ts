import { getConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";

/**
 * Validates env and config at web server start. On failure the
 * process exits, so a missing SESSION_SECRET or an invalid config/*.json stops the container instead of serving 500s
 * (Next only logs a failed register() and keeps listening). Skipped during `next build`,
 * which must work without runtime secrets.
 */
export function validateStartup(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    getEnv();
    getConfig();
  } catch (err) {
    // The logger itself needs a valid env, so write directly. Zod env issues name variables, never values.
    process.stderr.write(`startup validation failed, exiting: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
