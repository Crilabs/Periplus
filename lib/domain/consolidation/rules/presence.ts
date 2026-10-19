import type { ConflictNote, ConsolidationInput, RuleContext } from "../types";
import { pickDiscrete, strongest } from "../weights";

type Presence = { present: boolean };

export type PresencePick = {
  present: boolean;
  /** The inputs of the picked presence group (original values). */
  inputs: ConsolidationInput[];
  /** The newest date of the picked group. */
  observedAt: string;
  conflict: Omit<ConflictNote, "resolution"> | null;
};

/**
 * Picks an object value with a `present` field on presence alone (spec 07 "Vorhandensein": `highlight.*`,
 * `mooring.buoys`, ruling M5-C-R2 I-1), with the month time course of `latest_observation` (ruling M5-C-R1 (3)).
 * `complete(present, inputs)` builds the full value from the inputs of one presence group; conflict sides carry that
 * full value, not `{ present }` alone (ruling M5-C-R1 (6)).
 */
export function pickPresence(
  live: ConsolidationInput[],
  ctx: RuleContext,
  complete: (present: boolean, inputs: ConsolidationInput[]) => unknown,
): PresencePick {
  const original = new Map<ConsolidationInput, ConsolidationInput>();
  const presence = live.map((i) => {
    const p = { ...i, value: { present: (i.value as Presence).present } };
    original.set(p, i);
    return p;
  });
  const { group, conflict } = pickDiscrete(presence, ctx, { granularity: "month" });
  const present = (group.value as Presence).present;
  const groupOf = (p: boolean) => live.filter((i) => (i.value as Presence).present === p);
  const full = <S extends { value: unknown }>(side: S): S => {
    const p = (side.value as Presence).present;
    return { ...side, value: complete(p, groupOf(p)) };
  };
  return {
    present,
    inputs: group.inputs.map((p) => original.get(p)!),
    observedAt: group.to,
    conflict: conflict && { ...conflict, a: full(conflict.a), b: full(conflict.b), others: conflict.others.map(full) },
  };
}

/**
 * The fields of the inputs' object values besides `present`, each from the strongest input carrying it (not null);
 * a field no input carries is null.
 */
export function fillFields(present: boolean, inputs: ConsolidationInput[], ctx: RuleContext): Record<string, unknown> {
  const fields = [...new Set(inputs.flatMap((i) => Object.keys(i.value as object)))].filter((f) => f !== "present").sort();
  const value: Record<string, unknown> = { present };
  for (const f of fields) {
    const carrier = strongest(
      inputs.filter((i) => (i.value as Record<string, unknown>)[f] != null),
      ctx,
    );
    value[f] = carrier ? (carrier.value as Record<string, unknown>)[f] : null;
  }
  return value;
}
