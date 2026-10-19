import type { ConsolidationInput, ConsolidationRule, InputOrigin, RuleContext, RuleResult } from "../types";
import { corrections, inputConfidence, roundTo, youngest } from "../weights";
import { ruleResult } from "./result";

/**
 * `shelter.<sector>` (spec 07): the youngest computation is the basis; corrections (texts, observations and review
 * decisions, the review with `confidence.review` and superseding what it saw) correct it by at most `maxCorrection`,
 * contradicting corrections give the worse value; without a computation the correction value holds. A port or marina
 * keeps `harbourFloor` unless the correction setting the value (confidence ≥ `openSideMinConfidence`, value ≤
 * `openSideMaxValue`) proves an open side; the floor has origin `rule` and cites no input, with
 * `harbourDefaultConfidence`.
 */
export const shelterRule: ConsolidationRule = (inputs, ctx) => {
  const p = ctx.cfg.rules.shelter;
  const harbour = ctx.place !== null && p.harbourKinds.includes(ctx.place.kind);
  const basis = youngest(inputs.filter((i) => i.origin === "computed"));
  const texts = corrections(inputs).filter((i) => typeof i.value === "number");

  if (!basis && texts.length === 0) return harbour ? harbourFloor(ctx) : null;

  const first = correct(basis, texts, ctx);
  if (!harbour || (first.result.value as number) >= p.harbourFloor) return first.result;

  const provesOpenSide = (i: ConsolidationInput) =>
    inputConfidence(i, ctx.cfg) >= p.openSideMinConfidence && (i.value as number) <= p.openSideMaxValue;
  if (first.setters.some(provesOpenSide)) return first.result;
  // the value-setting correction proves nothing: a proving correction sets the value, otherwise the floor holds
  const proving = texts.filter(provesOpenSide);
  if (proving.length === 0) return harbourFloor(ctx);
  const second = correct(basis, proving, ctx);
  return (second.result.value as number) < p.harbourFloor ? second.result : harbourFloor(ctx);
};

function harbourFloor(ctx: RuleContext): RuleResult {
  const p = ctx.cfg.rules.shelter;
  return { value: p.harbourFloor, origin: "rule", confidence: p.harbourDefaultConfidence, observedAt: null, support: [], conflict: null };
}

/**
 * The basis corrected by the worst correction (clamped to ±`maxCorrection`). `setters` carry the worse value. The
 * second-source bonus counts only inputs carrying the result value: the basis only when the clamp left it unchanged.
 */
function correct(
  basis: ConsolidationInput | null,
  texts: ConsolidationInput[],
  ctx: RuleContext,
): { result: RuleResult; setters: ConsolidationInput[] } {
  const p = ctx.cfg.rules.shelter;
  if (texts.length === 0) return { result: ruleResult(basis!.value, "computed", [basis!], ctx), setters: [] };

  const worst = Math.min(...texts.map((i) => i.value as number));
  const setters = texts.filter((i) => i.value === worst);
  const value = basis
    ? Math.min(Math.max(worst, (basis.value as number) - p.maxCorrection), (basis.value as number) + p.maxCorrection)
    : worst;
  const origin: InputOrigin = setters.some((i) => i.origin === "review")
    ? "review"
    : setters.some((i) => i.origin === "text")
      ? "text"
      : "observed";

  const carries = (i: ConsolidationInput) => roundTo(i.value as number, ctx.cfg.precision) === roundTo(value, ctx.cfg.precision);
  const confirming = (basis ? [basis, ...texts] : texts).filter(carries);
  const support = [...new Set([...(basis ? [basis] : []), ...setters, ...confirming])];
  return { result: ruleResult(value, origin, support, ctx, confirming), setters };
}
