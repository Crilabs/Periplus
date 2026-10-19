import type { ConsolidationRule } from "../types";
import { isTextual, youngest } from "../weights";
import { ruleResult } from "./result";

/**
 * `shelter.<sector>` (spec 07): the youngest computation is the basis; texts and observations correct it by at most
 * `maxCorrection`, contradicting texts give the worse value; without a computation the text value holds. A port or
 * marina keeps `harbourFloor` unless a text (confidence ≥ `openSideMinConfidence`, value ≤ `openSideMaxValue`) proves
 * an open side; one without any input gets the floor with `harbourDefaultConfidence`.
 */
export const shelterRule: ConsolidationRule = (inputs, ctx) => {
  const p = ctx.cfg.rules.shelter;
  const harbour = ctx.place !== null && p.harbourKinds.includes(ctx.place.kind);
  const basis = youngest(inputs.filter((i) => i.origin === "computed"));
  const texts = inputs.filter((i) => isTextual(i.origin) && typeof i.value === "number");

  if (!basis && texts.length === 0) {
    if (!harbour) return null;
    return { value: p.harbourFloor, origin: "computed", confidence: p.harbourDefaultConfidence, observedAt: null, support: [], conflict: null };
  }

  let value: number;
  let result: ReturnType<typeof ruleResult>;
  if (texts.length === 0) {
    value = basis!.value as number;
    result = ruleResult(value, "computed", [basis!], ctx);
  } else {
    const textValue = Math.min(...texts.map((i) => i.value as number));
    const worse = texts.filter((i) => i.value === textValue);
    value = basis
      ? Math.min(Math.max(textValue, (basis.value as number) - p.maxCorrection), (basis.value as number) + p.maxCorrection)
      : textValue;
    const origin = worse.some((i) => i.origin === "text") ? "text" : "observed";
    result = ruleResult(value, origin, basis ? [basis, ...worse] : worse, ctx);
  }

  if (harbour) {
    const openSide = texts.some((i) => i.confidence >= p.openSideMinConfidence && (i.value as number) <= p.openSideMaxValue);
    if (!openSide && value < p.harbourFloor) return { ...result, value: p.harbourFloor };
  }
  return result;
};
