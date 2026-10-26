import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
// Imported, not read: the web image carries no drizzle/ directory, a static import is bundled into the build.
import journal from "@/drizzle/meta/_journal.json";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { gateConfigOf } from "@/lib/domain/research/gate-report";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** SHA-256 over the JSON with its object keys sorted at every depth (array order counts), first 16 hex characters. */
export function configHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex").slice(0, 16);
}

export type DeployVersion = {
  gitSha: string | null;
  lastMigration: { tag: string; appliedAt: string } | null;
  configHash: string;
  gateConfigHash: string;
  config: Pick<AppConfig, "research" | "quality" | "budgets" | "models">;
};

/**
 * What runs: the image's git sha, the newest applied migration and the effective config (no secrets, those are env).
 * A newest migration the bundled journal does not know is tagged `unbekannt`: the database is ahead of the image.
 */
export async function deployVersion(db: Db, cfg: AppConfig, env: { GIT_SHA?: string }): Promise<DeployVersion> {
  const res = await db.execute(sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`);
  const createdAt = res.rows[0]?.created_at;
  const when = createdAt === undefined ? undefined : Number(createdAt);
  const entry = journal.entries.find((e) => e.when === when);
  const config = { research: cfg.research, quality: cfg.quality, budgets: cfg.budgets, models: cfg.models };
  return {
    gitSha: env.GIT_SHA ?? null,
    lastMigration: when === undefined ? null : { tag: entry?.tag ?? "unbekannt", appliedAt: new Date(when).toISOString() },
    configHash: configHash(config),
    gateConfigHash: configHash(gateConfigOf(cfg)),
    config,
  };
}
