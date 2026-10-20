import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { DELIVERY_STAGE } from "@/lib/pipeline/delivery";
import { startRun } from "@/lib/pipeline/runs";

// Kept apart from ./delivery: the job handler imports that module, and this one reaches the stage registry through
// ./runs, which would close an import cycle through the handler (ruling M6-P17).

/**
 * Starts the run "Paket bauen" for one subdivision (scope `subdivision` with its key, as the other subdivision runs),
 * stage `delivery.build`. The subdivision is checked before the run exists: it must be valid and not excluded; an
 * unknown key, an excluded subdivision and a leftover area key (`saronic`) throw with a message naming the way out
 * (`requireSubdivision`). A partly built subdivision may be delivered: the package holds what is processed so far.
 */
export async function startDeliveryRun(db: Db, boss: PgBoss, subdivisionKey: string, triggeredBy: string): Promise<{ id: string }> {
  const subdivision = await requireSubdivision(db, subdivisionKey);
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "subdivision", id: subdivision.key },
    stages: [DELIVERY_STAGE],
    params: { subdivisionId: subdivision.id, subdivisionKey: subdivision.key },
    triggeredBy,
  });
}
