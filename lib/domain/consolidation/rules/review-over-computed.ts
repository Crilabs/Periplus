import type { ConsolidationRule } from "../types";
import { youngest } from "../weights";
import { ruleResult } from "./result";

/** A correction (review or observation) beats the computation: the youngest correction, otherwise the youngest computation. */
export const reviewOverComputedRule: ConsolidationRule = (inputs, ctx) => {
  const correction = youngest(inputs.filter((i) => i.origin === "review" || i.origin === "observed"));
  if (correction) return ruleResult(correction.value, correction.origin, [correction], ctx);
  const basis = youngest(inputs.filter((i) => i.origin === "computed"));
  return basis ? ruleResult(basis.value, "computed", [basis], ctx) : null;
};
