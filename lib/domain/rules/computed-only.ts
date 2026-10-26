import type { ConsolidationRule } from "./types";
import { youngest } from "./weights";
import { ruleResult } from "./result";

/** Attributes only a computation delivers: the youngest computation; any other input is ignored. */
export const computedOnlyRule: ConsolidationRule = (inputs, ctx) => {
  const basis = youngest(inputs.filter((i) => i.origin === "computed"));
  return basis ? ruleResult(basis.value, "computed", [basis], ctx) : null;
};
