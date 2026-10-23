import { inArray } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { researchCandidates } from "./candidates";
import { adminStatusStands, decideBerth, isDecidedStatus, loadEvidence, statusSetByAdmin, type Verdict } from "./confirmation";

/*
 * The reference gate (plan N3): which places the confirmation rule would confirm at each threshold of independent
 * sources, decided on the same evidence and without writing anything.
 */

/**
 * The verdict of each researched place of the subdivision (`researchCandidates`) at each threshold `n`
 * (`minIndependentSources: n`), keyed by threshold, then place id. The evidence is loaded once. The status rules are
 * those of `applyBerthVerdicts`: a status an admin set stands (as its own status) at every threshold, except an admin's
 * confirmation against an authority ban, which the rule decides; a place of a final status (`rejected`, `abandoned`,
 * `no_anchoring`) is not a candidate and is left out. Reads only: no status, decision or task is written, and the
 * checks that wait for a duplicate review or a restricted area (`applyVerdict`) are not applied.
 */
export async function verdictsByThreshold(
  db: Db,
  subdivisionKey: string,
  thresholds: number[],
  cfg: AppConfig,
): Promise<Map<number, Map<string, Verdict>>> {
  const ids = await researchCandidates(db, { subdivisionKey });
  const evidence = await loadEvidence(db, ids, cfg);
  const rows =
    ids.length === 0
      ? []
      : await db.select({ id: places.id, kind: places.kind, status: places.status, geoObjectId: places.geoObjectId }).from(places).where(inArray(places.id, ids));
  const adminSet = new Map<string, boolean>();
  for (const r of rows) adminSet.set(r.id, isDecidedStatus(r.status) && (await statusSetByAdmin(db, r.id, r.geoObjectId)));

  const out = new Map<number, Map<string, Verdict>>();
  for (const n of thresholds) {
    const byPlace = new Map<string, Verdict>();
    for (const r of rows) {
      if (!isDecidedStatus(r.status)) continue;
      const e = evidence.get(r.id) ?? [];
      const verdict = decideBerth(r.kind, e, { ...cfg.research.confirmation, minIndependentSources: n });
      byPlace.set(
        r.id,
        adminSet.get(r.id) && adminStatusStands(r.status, verdict, e)
          ? { status: r.status as "candidate" | "confirmed", reason: "Status von einem Admin gesetzt", independentSources: verdict.independentSources, blockingSignalId: null, signalIds: [] }
          : verdict,
      );
    }
    out.set(n, byPlace);
  }
  return out;
}
