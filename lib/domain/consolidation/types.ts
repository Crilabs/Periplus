import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { PlaceKind, PlaceStatus } from "@/lib/db/schema/geo";
import type { DocType } from "@/lib/db/schema/sources";
import type { FactLevel } from "@/lib/domain/facts/schema-types";

/*
 * Types of the consolidated profile (spec 07). Types only: the rules live in `lib/domain/consolidation/rules/`,
 * their parameters in `config/consolidation/<version>.json`.
 */

/** Where a consolidation input comes from. */
export type InputOrigin = "computed" | "text" | "review" | "observed";

/** Where a profile value comes from: an input origin, the gazetteer (identity fields) or a derived value. */
export type ProvenanceOrigin = InputOrigin | "gazetteer" | "derived";

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

/** An admin's answer to a conflict: both values hold seasonally, or the conflict stays open. */
export type ConflictResolution = "seasonal" | "left_open";

/** One side of a conflict: a value with its summed weight and what supports it. */
export type ConflictSide = {
  value: unknown;
  weight: number;
  factIds: string[];
  sourceKeys: string[];
  observedFrom: string;
  observedTo: string;
};

/** Two values that cannot be ordered over time and weigh within the conflict ratio; the profile shows the heavier one. */
export type ConflictNote = {
  attribute: string;
  /** Stable key of the two values (decisions refer to it). */
  key: string;
  a: ConflictSide;
  b: ConflictSide;
  resolution: ConflictResolution | null;
};

/**
 * Where one profile value comes from. A proposed change under review is not stored here (ruling M5-P8): the view
 * derives it from the open `uncertain_change` task.
 */
export type AttributeProvenance = {
  origin: ProvenanceOrigin;
  rule: RuleName | "identity" | "derived";
  confidence: number;
  confidenceClass: ConfidenceClass;
  observedAt: string | null;
  lastConfirmedAt: string | null;
  factIds: string[];
  sourceKeys: string[];
  computationIds: string[];
  poiIds: string[];
  /** Older than two cycles of the tile: the value stays, its confidence drops one class. */
  expired: boolean;
  /** Every supporting document is gone: the value is no longer "currently confirmed". */
  onlyGoneSources: boolean;
  conflictKey: string | null;
  observedMonths: number[];
};

/** An attribute without a value, and why (e.g. `no_facts`, or a computation gap's reason). */
export type ProfileGap = { attribute: string; reason: string };

/** One stored profile version (table `profiles`). */
export type ProfileSnapshot = {
  version: number;
  validFrom: string;
  attributes: Record<string, unknown>;
  provenance: Record<string, AttributeProvenance>;
  conflicts: ConflictNote[];
  gaps: ProfileGap[];
  sourcesCount: number;
  documentsCount: number;
  confidence: number | null;
  contentHash: string;
  rulesVersion: string;
  factSchemaVersion: string;
};

/**
 * One input of a rule: a fact (text, review, observation), a computation output or a POI. `sourceKey` identifies the
 * independent source (documents of one source count once); `sourceWeight` is the source's weight (`sources.weight`,
 * or `weights.computed`/`review`/`observed`/`poi`); `dateKnown false` means `observedAt` is no observation date.
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
  origin: InputOrigin;
  confidence: number;
  observedAt: string | null;
  support: ConsolidationInput[];
  conflict: Omit<ConflictNote, "resolution"> | null;
};

/** A pure consolidation rule (spec 07); `null` = no value. */
export type ConsolidationRule = (inputs: ConsolidationInput[], ctx: RuleContext) => RuleResult | null;
