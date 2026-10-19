import { createHash } from "node:crypto";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import { canonicalJson } from "@/lib/domain/facts/schema";
import type { ConfidenceClass, ConflictNote, ConflictSide, ConsolidationInput, InputOrigin, RuleContext } from "./types";

/*
 * Weights, confidence and the discrete pick of spec 07. Pure functions; parameters from `ctx.cfg`
 * (`config/consolidation/<version>.json`).
 */

const DAY_MS = 86_400_000;
const CLASS_ORDER: readonly ConfidenceClass[] = ["high", "medium", "low"];

/** `n` rounded to `precision` decimals. */
export function roundTo(n: number, precision: number): number {
  const f = 10 ** precision;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** A top-level number rounded to the config precision; any other value unchanged (coordinates keep their digits). */
export function roundValue(value: unknown, cfg: ConsolidationConfig): unknown {
  return typeof value === "number" ? roundTo(value, cfg.precision) : value;
}

function days(from: string, to: string): number {
  return (Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / DAY_MS;
}

/** `0.5 ^ (age in years / halfLife)`, age = days / 365.25; a date in the future counts as today (never > 1). */
export function recency(observedAt: string, today: string, halfLifeYears: number): number {
  const years = days(observedAt, today) / 365.25;
  return years <= 0 ? 1 : 0.5 ** (years / halfLifeYears);
}

/** Text and observations age; computations and review decisions do not. */
export function isTextual(origin: InputOrigin): boolean {
  return origin === "text" || origin === "observed";
}

/** Inputs that correct a computation: text, observations and review decisions. */
export function isCorrection(origin: InputOrigin): boolean {
  return isTextual(origin) || origin === "review";
}

/** An input's confidence; a review decision enters with `confidence.review` (spec 07: "künftig mit Konfidenz 0,95"). */
export function inputConfidence(i: ConsolidationInput, cfg: ConsolidationConfig): number {
  return i.origin === "review" ? cfg.confidence.review : i.confidence;
}

/** `sourceWeight × confidence × recency` (recency only for text and observations; a review with `confidence.review`). */
export function inputWeight(i: ConsolidationInput, ctx: RuleContext): number {
  const age = isTextual(i.origin) ? recency(i.observedAt, ctx.today, ctx.cfg.recency.halfLifeYears) : 1;
  return i.sourceWeight * inputConfidence(i, ctx.cfg) * age;
}

/**
 * The inputs without what the youngest review decision saw: older reviews and texts/observations not younger than it
 * drop out; younger texts/observations, computations and POIs stay and compete with it (ruling M5-B-R3).
 */
export function afterReview(inputs: ConsolidationInput[]): ConsolidationInput[] {
  const decision = youngest(inputs.filter((i) => i.origin === "review"));
  if (!decision) return inputs;
  return inputs.filter(
    (i) => i === decision || (i.origin !== "review" && (!isTextual(i.origin) || i.observedAt > decision.observedAt)),
  );
}

/** The correction inputs a rule weighs (text, observations, reviews), after the youngest review's supersession. */
export function corrections(inputs: ConsolidationInput[]): ConsolidationInput[] {
  return afterReview(inputs).filter((i) => isCorrection(i.origin));
}

/** Independent sources: documents of one source count once. */
export function independentCount(inputs: ConsolidationInput[]): number {
  return new Set(inputs.map((i) => i.sourceKey)).size;
}

function baseConfidence(i: ConsolidationInput, cfg: ConsolidationConfig): number {
  if (i.origin === "computed") return i.confidence;
  if (i.origin === "review") return cfg.confidence.review;
  return i.confidence * i.sourceWeight;
}

/** A stable id of an input for tie-breaks and conflict keys: the fact id, else `computation:<id>` / `poi:<id>`. */
function inputId(i: ConsolidationInput): string {
  return i.factId ?? (i.computationId ? `computation:${i.computationId}` : i.poiId ? `poi:${i.poiId}` : "");
}

/** The youngest input (largest `observedAt`; ties by id), or null. */
export function youngest(inputs: ConsolidationInput[]): ConsolidationInput | null {
  let best: ConsolidationInput | null = null;
  for (const i of inputs) {
    if (!best || i.observedAt > best.observedAt || (i.observedAt === best.observedAt && inputId(i) > inputId(best))) best = i;
  }
  return best;
}

/** The input with the highest `inputWeight`; ties go to the youngest, then by id. */
export function strongest(inputs: ConsolidationInput[], ctx: RuleContext): ConsolidationInput | null {
  let best: ConsolidationInput | null = null;
  let bestWeight = -1;
  for (const i of inputs) {
    const w = inputWeight(i, ctx);
    if (!best || w > bestWeight || (w === bestWeight && youngest([best, i]) === i)) {
      best = i;
      bestWeight = w;
    }
  }
  return best;
}

/**
 * Confidence of an attribute from its supporting inputs: the largest base (computed: its confidence; review:
 * `confidence.review`; text/observation: confidence × source weight), plus `secondSourceBonus` when two independent
 * sources among `confirming` (default: the support) carry the value, capped, then aged with the recency of the
 * youngest text/observation when the value comes from text/observation. `origin` is the result's origin; without it,
 * the origin of the input with the largest base counts.
 */
export function attributeConfidence(
  support: ConsolidationInput[],
  ctx: RuleContext,
  origin?: InputOrigin,
  confirming: ConsolidationInput[] = support,
): number {
  const { cfg } = ctx;
  if (support.length === 0) return 0;
  let top = support[0];
  for (const i of support) if (baseConfidence(i, cfg) > baseConfidence(top, cfg)) top = i;
  let c = baseConfidence(top, cfg);
  if (independentCount(confirming) >= 2) c += cfg.confidence.secondSourceBonus;
  c = Math.min(c, cfg.confidence.cap);
  if (isTextual(origin ?? top.origin)) {
    const latest = youngest(support.filter((i) => isTextual(i.origin)));
    if (latest) c *= recency(latest.observedAt, ctx.today, cfg.recency.halfLifeYears);
  }
  return roundTo(c, cfg.precision);
}

/** The class of a confidence: the first class (high → low) whose minimum it reaches. */
export function confidenceClass(c: number, cfg: ConsolidationConfig): ConfidenceClass {
  return (cfg.confidence.classes.find((k) => c >= k.min) ?? cfg.confidence.classes[cfg.confidence.classes.length - 1]).name;
}

/** One class lower; `low` stays `low`. */
export function lowerClass(c: ConfidenceClass): ConfidenceClass {
  return CLASS_ORDER[Math.min(CLASS_ORDER.indexOf(c) + 1, CLASS_ORDER.length - 1)];
}

/** The middle of a class's range (high 0.85, medium 0.55, low 0.2 with v1). */
export function classMidpoint(c: ConfidenceClass, cfg: ConsolidationConfig): number {
  const classes = cfg.confidence.classes;
  const idx = classes.findIndex((k) => k.name === c);
  const upper = idx === 0 ? 1 : classes[idx - 1].min;
  return roundTo((classes[idx].min + upper) / 2, cfg.precision);
}

export type ValueGroup = {
  key: string;
  value: unknown;
  inputs: ConsolidationInput[];
  weight: number;
  from: string;
  to: string;
  years: number[];
  allDatesKnown: boolean;
};

/**
 * Inputs grouped by value (`canonicalJson`); a group weighs the sum over its sources of each source's strongest input
 * (ruling M5-P4: duplicated mentions count once). Sorted by weight descending, then key.
 */
export function valueGroups(inputs: ConsolidationInput[], ctx: RuleContext): ValueGroup[] {
  const byKey = new Map<string, ConsolidationInput[]>();
  for (const i of inputs) {
    const key = canonicalJson(i.value);
    const list = byKey.get(key);
    if (list) list.push(i);
    else byKey.set(key, [i]);
  }
  const groups: ValueGroup[] = [];
  for (const [key, list] of byKey) {
    const perSource = new Map<string, number>();
    for (const i of list) perSource.set(i.sourceKey, Math.max(perSource.get(i.sourceKey) ?? 0, inputWeight(i, ctx)));
    const dates = list.map((i) => i.observedAt.slice(0, 10)).sort();
    groups.push({
      key,
      value: list[0].value,
      inputs: list,
      weight: [...perSource.values()].reduce((a, b) => a + b, 0),
      from: dates[0],
      to: dates[dates.length - 1],
      years: [...new Set(dates.map((d) => Number(d.slice(0, 4))))].sort((a, b) => a - b),
      allDatesKnown: list.every((i) => i.dateKnown),
    });
  }
  return groups.sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function ids(group: ValueGroup): string[] {
  return group.inputs.map(inputId).filter((id) => id !== "");
}

function side(group: ValueGroup, cfg: ConsolidationConfig): ConflictSide {
  return {
    value: group.value,
    weight: roundTo(group.weight, cfg.precision),
    factIds: [...new Set(group.inputs.flatMap((i) => (i.factId ? [i.factId] : [])))].sort(),
    sourceKeys: [...new Set(group.inputs.map((i) => i.sourceKey))].sort(),
    observedFrom: group.from,
    observedTo: group.to,
  };
}

/** First 16 hex of sha256 over the sorted input ids of both groups (fact ids; computations and POIs prefixed). */
export function conflictKey(a: ValueGroup, b: ValueGroup): string {
  const all = [...new Set([...ids(a), ...ids(b)])].sort();
  return createHash("sha256").update(canonicalJson(all)).digest("hex").slice(0, 16);
}

/** A conflict note: `picked` against the heaviest other group, any further groups in `others` (`rest` heaviest first). */
export function conflictNote(
  attribute: string,
  picked: ValueGroup,
  rest: ValueGroup[],
  cfg: ConsolidationConfig,
): Omit<ConflictNote, "resolution"> {
  const [second, ...more] = rest;
  return {
    attribute,
    key: conflictKey(picked, second),
    a: side(picked, cfg),
    b: side(second, cfg),
    others: more.map((g) => side(g, cfg)),
  };
}

/**
 * Picks one value among discrete inputs (spec 07):
 * 1. one group → it;
 * 2. time course (option `timeCourse`, default true): every date known and every year of the youngest group after
 *    every year of the others → the youngest group, no conflict;
 * 3. otherwise the heaviest group; when it weighs less than `conflict.minRatio` times the second, with a conflict
 *    note (`a` = picked, `b` = second, `others` = any further groups).
 * Throws on empty inputs.
 */
export function pickDiscrete(
  inputs: ConsolidationInput[],
  ctx: RuleContext,
  opts: { timeCourse?: boolean } = {},
): { group: ValueGroup; conflict: Omit<ConflictNote, "resolution"> | null } {
  const groups = valueGroups(inputs, ctx);
  if (groups.length === 0) throw new Error("pickDiscrete needs at least one input");
  if (groups.length === 1) return { group: groups[0], conflict: null };

  if (opts.timeCourse ?? true) {
    let latest = groups[0];
    for (const g of groups) if (g.to > latest.to || (g.to === latest.to && g.key < latest.key)) latest = g;
    const others = groups.filter((g) => g !== latest);
    if (groups.every((g) => g.allDatesKnown) && Math.min(...latest.years) > Math.max(...others.flatMap((g) => g.years))) {
      return { group: latest, conflict: null };
    }
  }

  const [top, second] = groups;
  if (second.weight > 0 && top.weight / second.weight < ctx.cfg.conflict.minRatio) {
    return { group: top, conflict: conflictNote(ctx.attribute, top, groups.slice(1), ctx.cfg) };
  }
  return { group: top, conflict: null };
}
