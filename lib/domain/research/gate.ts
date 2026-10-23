import { inArray } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { researchCandidates } from "./candidates";
import { ADMIN_SET_REASON, adjustVerdict, loadEvidence, type Verdict } from "./confirmation";

/*
 * The reference gate (plan N3): which places the confirmation rule would deliver as confirmed at each threshold of
 * independent sources, decided on the same evidence and without writing anything.
 */

/**
 * The verdict of each researched place of the subdivision (`researchCandidates`) at each threshold `n`
 * (`minIndependentSources: n`), keyed by threshold, then place id, all read in one read-only transaction (one snapshot;
 * `verdictsIn` reads in the caller's).
 * The verdict is what `applyBerthVerdicts` would deliver (`adjustVerdict`, shared with it): the rule, a status an admin
 * set standing (as its own status, reason `ADMIN_SET_REASON`), a confirmation held by an open duplicate review, a
 * candidate in a banning restricted area `no_anchoring`. A place of a final status (`rejected`, `abandoned`,
 * `no_anchoring`) is not a candidate and is left out, except the places in `opts.includePlaceIds` (those with a human gate
 * decision): they get the pure rule verdict (`ruleOnly`) whatever their status, so they stay in the count. Writes nothing.
 */
export async function verdictsByThreshold(
  db: Db,
  subdivisionKey: string,
  thresholds: number[],
  cfg: AppConfig,
  opts: { includePlaceIds?: string[] } = {},
): Promise<Map<number, Map<string, Verdict>>> {
  return db.transaction((tx) => verdictsIn(tx, subdivisionKey, thresholds, cfg, opts), { accessMode: "read only", isolationLevel: "repeatable read" });
}

/** `verdictsByThreshold` in the caller's transaction (the gate measurement reads everything in one snapshot). */
export async function verdictsIn(
  tx: Db,
  subdivisionKey: string,
  thresholds: number[],
  cfg: AppConfig,
  opts: { includePlaceIds?: string[] } = {},
): Promise<Map<number, Map<string, Verdict>>> {
  const candidateIds = await researchCandidates(tx, { subdivisionKey });
  const included = new Set(opts.includePlaceIds ?? []);
  const ids = [...new Set([...candidateIds, ...included])].sort();
  const evidence = await loadEvidence(tx, ids, cfg);
  const rows = ids.length === 0 ? [] : await tx.select({ id: places.id, kind: places.kind, status: places.status, geoObjectId: places.geoObjectId }).from(places).where(inArray(places.id, ids));

  const out = new Map<number, Map<string, Verdict>>(thresholds.map((n) => [n, new Map()]));
  for (const n of thresholds) {
    const rule = { ...cfg, research: { ...cfg.research, confirmation: { ...cfg.research.confirmation, minIndependentSources: n } } };
    for (const r of rows) {
      const adjusted = await adjustVerdict(tx, { id: r.id, geoObjectId: r.geoObjectId, kind: r.kind, status: r.status }, evidence.get(r.id) ?? [], rule, { ruleOnly: included.has(r.id) });
      out.get(n)!.set(
        r.id,
        adjusted.stands
          ? { status: r.status as "candidate" | "confirmed", reason: ADMIN_SET_REASON, independentSources: adjusted.verdict.independentSources, blockingSignalId: null, signalIds: [] }
          : { ...adjusted.verdict, status: adjusted.to, reason: adjusted.reason },
      );
    }
  }
  return out;
}
