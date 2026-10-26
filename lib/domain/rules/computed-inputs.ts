import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { latestComputations } from "@/lib/domain/facts/computations";
import type { ConsolidationInput } from "./types";

const utcDate = (d: Date) => d.toISOString().slice(0, 10);

/** The facts of the newest computation per kind (`computed:<kind>`), confirmed on the computation's date; also the berth state's computed inputs (N4a). */
export async function computedInputs(db: Db, geoObjectId: string, cfg: ConsolidationConfig): Promise<ConsolidationInput[]> {
  const inputs: ConsolidationInput[] = [];
  for (const c of (await latestComputations(db, geoObjectId)).values()) {
    for (const f of c.facts) {
      inputs.push({
        factId: f.id,
        attribute: f.attribute,
        value: f.value,
        origin: "computed",
        confidence: f.confidence,
        observedAt: f.observedAt,
        dateKnown: true,
        sourceKey: `computed:${c.kind}`,
        sourceWeight: cfg.weights.computed,
        sourceType: null,
        documentId: null,
        gone: false,
        lastConfirmedAt: utcDate(c.createdAt),
        computationId: c.id,
        poiId: null,
      });
    }
  }
  return inputs;
}
