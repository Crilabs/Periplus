import { getConsolidationConfig } from "@/lib/config";
import type { VersionedConsolidationConfig } from "@/lib/config/schemas";

/*
 * The rules version of the berth-state rules (`config/consolidation/`): `active.json` names it. A research run freezes
 * it in `params.rulesVersion`, so every berth of a run is decided by one version; every reader without a frozen
 * version asks this module (`getConsolidationConfig()` without a version is called here only).
 */

/** The active rules version (`config/consolidation/active.json`). */
export function activeRulesVersion(): string {
  return getConsolidationConfig().version;
}

/**
 * The rules of `version` (a run's frozen `params.rulesVersion`), of the active version when none is given
 * (`undefined`). Any other non-string value (corrupted params) throws instead of falling back silently.
 */
export function consolidationConfigFor(version?: unknown): VersionedConsolidationConfig {
  if (version === undefined) return getConsolidationConfig();
  if (typeof version !== "string") throw new Error(`rules version must be a string, got ${JSON.stringify(version)}`);
  return getConsolidationConfig(version);
}
