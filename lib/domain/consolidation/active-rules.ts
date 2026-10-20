import { and, desc, eq } from "drizzle-orm";
import { consolidationVersions, getConsolidationConfig } from "@/lib/config";
import type { VersionedConsolidationConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { configActivations } from "@/lib/db/schema";

/*
 * The active consolidation rules version (ruling M7-P10, spec 10 „Aktivieren ist ein bewusster Klick“): the newest
 * activation of kind `consolidation_rules` in `config_activations` whose version is released as a file in
 * `config/consolidation/`, else `config/consolidation/active.json`. Every reader that does not get a version (the
 * consolidation of text, geometry and consolidation runs, summaries, follow-ups, delivery, review facts) asks this
 * module; `getConsolidationConfig()` without a version is called here only (a grep test holds it).
 */

/** The active rules version: the newest released activation, else `active.json`. */
export async function activeRulesVersion(db: Db): Promise<string> {
  const released = new Set(consolidationVersions());
  const rows = await db
    .select({ version: configActivations.version })
    .from(configActivations)
    .where(eq(configActivations.kind, "consolidation_rules"))
    .orderBy(desc(configActivations.activatedAt), desc(configActivations.id));
  return rows.find((r) => released.has(r.version))?.version ?? getConsolidationConfig().version;
}

/**
 * The rules of `version` (a run's frozen `params.rulesVersion` or a job's `rulesVersion`), of the active version when
 * none is given (`undefined`). Any other non-string value (corrupted params) throws instead of falling back silently.
 */
export async function consolidationConfigFor(db: Db, version?: unknown): Promise<VersionedConsolidationConfig> {
  if (version === undefined) return getConsolidationConfig(await activeRulesVersion(db));
  if (typeof version !== "string") throw new Error(`rules version must be a string, got ${JSON.stringify(version)}`);
  return getConsolidationConfig(version);
}

/** The version string of an extraction configuration in `config_activations`: `<model>@p<promptVersion>`. */
export const extractionVersion = (e: { model: string; promptVersion: number }) => `${e.model}@p${e.promptVersion}`;

/** The newest activation of `kind` with this version, null without one. */
export async function activationOf(
  db: Db,
  kind: "consolidation_rules" | "extraction",
  version: string,
): Promise<{ activatedAt: Date; activatedBy: string; evaluationRunId: string } | null> {
  const [row] = await db
    .select({ activatedAt: configActivations.activatedAt, activatedBy: configActivations.activatedBy, evaluationRunId: configActivations.evaluationRunId })
    .from(configActivations)
    .where(and(eq(configActivations.kind, kind), eq(configActivations.version, version)))
    .orderBy(desc(configActivations.activatedAt), desc(configActivations.id))
    .limit(1);
  return row ?? null;
}
