import type { ConsolidationInput } from "./types";
import { inputId } from "./weights";

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Inputs by (attribute, observedAt, fact or POI id), then the remaining ids and the source: a total order. */
export function byAttributeDateId(a: ConsolidationInput, b: ConsolidationInput): number {
  return (
    cmp(a.attribute, b.attribute) ||
    cmp(a.observedAt, b.observedAt) ||
    cmp(a.factId ?? a.poiId ?? "", b.factId ?? b.poiId ?? "") ||
    cmp(inputId(a), inputId(b)) ||
    cmp(a.sourceKey, b.sourceKey)
  );
}
