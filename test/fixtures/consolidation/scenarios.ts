import { beforeEach } from "vitest";
import { getConsolidationConfig } from "@/lib/config";
import type { ConsolidationInput, RuleContext } from "@/lib/domain/rules/types";

/*
 * Builders for consolidation inputs and rule contexts (pure rule tests, no DB). Defaults: today 2026-10-19, an
 * observation of today with a known date, so recency is 1 unless a test sets `observedAt`.
 */

export const TODAY = "2026-10-19";

let seq = 0;
// ids restart in every test, so id-based tie-breaks do not depend on test order
beforeEach(() => {
  seq = 0;
});
const nextId = (prefix: string) => `${prefix}-${String(++seq).padStart(4, "0")}`;

function input(origin: ConsolidationInput["origin"], over: Partial<ConsolidationInput>): ConsolidationInput {
  return {
    factId: null,
    attribute: "shelter.N",
    value: 0.5,
    origin,
    confidence: 0.8,
    observedAt: TODAY,
    dateKnown: true,
    sourceKey: "source:a",
    sourceWeight: 1,
    sourceType: null,
    documentId: null,
    gone: false,
    lastConfirmedAt: TODAY,
    computationId: null,
    poiId: null,
    ...over,
  };
}

/** A text fact (own fact id, source `source:a`, weight 1, confidence 0.8). */
export function text(over: Partial<ConsolidationInput> = {}): ConsolidationInput {
  return input("text", { factId: nextId("fact"), documentId: nextId("doc"), sourceType: "pilot_guide", ...over });
}

/** A computation output (source `computed`, weight 1, confidence 0.6). */
export function computed(over: Partial<ConsolidationInput> = {}): ConsolidationInput {
  return input("computed", { computationId: nextId("comp"), sourceKey: "computed", confidence: 0.6, ...over });
}

/** A review fact (source `review`, weight 1, confidence 0.95). */
export function review(over: Partial<ConsolidationInput> = {}): ConsolidationInput {
  return input("review", { factId: nextId("fact"), sourceKey: "review", confidence: 0.95, ...over });
}

/** A rule context for a place (anchorage, confirmed) with the repo's active consolidation config. */
export function ruleCtx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    attribute: "shelter.N",
    level: "place",
    place: { kind: "anchorage", status: "confirmed" },
    today: TODAY,
    cfg: getConsolidationConfig(),
    ...over,
  };
}
