import type { ConfidenceClass, ConflictNote, RuleName, RuleOrigin } from "@/lib/domain/rules/types";

/*
 * Types of the consolidated profile (spec 07). Types only: the rules and their types live in `lib/domain/rules/`.
 */

/** Where a profile value comes from: a rule origin, the gazetteer (identity fields) or a derived value. */
export type ProvenanceOrigin = RuleOrigin | "gazetteer" | "derived";

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
  /**
   * Every supporting document is gone and no input outside documents (computation, review, observation, POI) carries
   * the value: it is no longer "currently confirmed" (part of the content hash, ruling M5-E-R3 M-1/M-2).
   */
  onlyGoneSources: boolean;
  conflictKey: string | null;
  observedMonths: number[];
  /**
   * List rules only (union lists `hazards`, `restricted_zones` …, ruling M5-C-R1 (5); `prohibitions`, ruling M5-E-R3):
   * entry identity key → the sorted input ids (`inputId`) naming the entry; an entry a review added cites the review
   * fact.
   */
  entryFactIds?: Record<string, string[]>;
  /**
   * Safety lists only (ruling M6-FIN-R3): entry identity key → `in_review` for a kept entry that cites no fact any
   * more (its source ended or was rejected) while the change removing it waits in an `uncertain_change` task. The
   * entry stays (safe direction) until the task is decided. Provenance, not part of the content hash.
   */
  entryMarkers?: Record<string, "in_review">;
  /**
   * Derived and identity values only (ruling M5-E-R3 I-3, M-5): the inputs that decided the value, which cannot be
   * reconstructed later (spatial candidates, sitelinks, the ferry basis). Provenance, not part of the content hash.
   */
  derivedFrom?: Record<string, unknown>;
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

