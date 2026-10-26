import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { PlaceKind, PlaceStatus } from "@/lib/db/schema/geo";
import type { DocType } from "@/lib/db/schema/sources";
import type { FactLevel } from "@/lib/domain/facts/schema-types";

/*
 * Types of the consolidation rules (spec 07, "Regeln je Kernwert bleiben"). Types only: the rules live next to this
 * file, their parameters in `config/consolidation/<version>.json`.
 */

/** Where a consolidation input comes from. */
export type InputOrigin = "computed" | "text" | "review" | "observed";

/** Where a rule's value comes from: an input origin, or `rule` when the rule itself sets it (the harbour floor). */
export type RuleOrigin = InputOrigin | "rule";

/** Consolidation rule names, as the fact schema's `rule` field names them (`union`: ruling M5-P3). */
export type RuleName =
  | "shelter"
  | "swell_protection"
  | "bathymetry"
  | "holding"
  | "latest_observation"
  | "highlight"
  | "occupancy"
  | "prohibitions"
  | "area_weighted"
  | "union"
  | "default"
  | "computed_only"
  | "review_over_computed";

export type ConfidenceClass = "high" | "medium" | "low";

/**
 * An admin's answer to a conflict: both values hold seasonally, the conflict stays open, or one value was picked
 * (`decided`: a `value_a` / `value_b` decision, which entered as a review fact; ruling M5-F-R3 M-2).
 */
export type ConflictResolution = "seasonal" | "left_open" | "decided";

/** One side of a conflict: a value with its summed weight and what supports it. */
export type ConflictSide = {
  value: unknown;
  weight: number;
  factIds: string[];
  sourceKeys: string[];
  observedFrom: string;
  observedTo: string;
};

/**
 * Two values that cannot be ordered over time and weigh within the conflict ratio; the profile shows the picked one
 * (`a`). Spec 07 names two values; further value groups are recorded in `others` (heaviest first) so the admin sees
 * them, but the key and the decision refer to `a` and `b`.
 */
export type ConflictNote = {
  attribute: string;
  /** Stable key of the two values (decisions refer to it). */
  key: string;
  a: ConflictSide;
  b: ConflictSide;
  others: ConflictSide[];
  resolution: ConflictResolution | null;
};

/**
 * One input of a rule: a fact (text, review, observation), a computation output or a POI. `sourceKey` identifies the
 * independent source (documents of one source count once); `sourceWeight` is the source's weight (`sources.weight`,
 * or `weights.computed`/`review`/`observed`/`poi`); `dateKnown false` means `observedAt` is no observation date.
 * Expiry (`lastConfirmedAt` older than two tile cycles) applies to text and observation inputs only, whether their
 * observation date is known or not (`lastConfirmedAt` of a text is always a real confirmation date); POI import
 * dates (origin `computed`), computed inputs and review inputs never expire (rulings M5-D-R2, M5-E-R3 I-1).
 */
export type ConsolidationInput = {
  factId: string | null;
  attribute: string;
  value: unknown;
  origin: InputOrigin;
  confidence: number;
  observedAt: string;
  dateKnown: boolean;
  sourceKey: string;
  sourceWeight: number;
  sourceType: DocType | null;
  documentId: string | null;
  gone: boolean;
  lastConfirmedAt: string;
  computationId: string | null;
  poiId: string | null;
};

/** What a rule knows beside its inputs; `today` is the run date (`YYYY-MM-DD`). */
export type RuleContext = {
  attribute: string;
  level: FactLevel;
  place: { kind: PlaceKind; status: PlaceStatus } | null;
  today: string;
  cfg: ConsolidationConfig;
};

/** A rule's answer for one attribute: the value, where it comes from and the inputs supporting it. */
export type RuleResult = {
  value: unknown;
  origin: RuleOrigin;
  confidence: number;
  observedAt: string | null;
  support: ConsolidationInput[];
  conflict: Omit<ConflictNote, "resolution"> | null;
  /**
   * List rules only (`union`, ruling M5-C-R1 (5); `prohibitions` by `kind`, computed entries by
   * `<kind>:<restrictedAreaId>`, ruling M5-E-R3): per entry of the value list, the sorted input ids (`inputId`: the
   * fact id, else `computation:`/`poi:`) of the inputs naming it, by the entry's identity key (`unionEntryKey(entry,
   * ctx)` in `rules/union.ts`). Bundles F/I: store it
   * as the per-entry provenance of safety lists (`hazards`, `restricted_zones`) and cite an entry's facts from it,
   * not from the flat `support`, which also holds removal decisions and inputs of other entries.
   */
  entryFactIds?: Record<string, string[]>;
  /**
   * Safety list rules only (`union`, `prohibitions`; GR-1): the entry keys a review removal decision took out and no
   * input observed after it names again, also when no current input names them, each with the observation date of
   * the youngest such removal. Change detection lets a text entry leave the profile only through such a decision (or
   * a withdrawn source), and only while no fact the previous profile cites for the entry is younger than that date
   * (GR-12); the rule may return a null value with only this map when the removals are its only inputs.
   */
  removedEntries?: Record<string, string>;
};

/** A pure consolidation rule (spec 07); `null` = no value. */
export type ConsolidationRule = (inputs: ConsolidationInput[], ctx: RuleContext) => RuleResult | null;
