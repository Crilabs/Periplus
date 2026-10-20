import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "@/lib/domain/ids";
import { places } from "./geo";
import { runs } from "./ops";
import { reviewTasks } from "./review";

/*
 * Quality measurement (spec 10). All three tables are append-only (forbid_mutation trigger,
 * drizzle/0045_quality_triggers.sql, which also holds the `in` checks of `attribute` and `metric` built from the lists
 * below). Grundprinzip 9: `comparison_results` stores the outcome of a comparison and the hash of the own value only;
 * it has no column a Navily value would fit in.
 */

/** The compared attributes (spec 10 „Existenz, Position, Schutz je Sektor, Tiefe, Grund, Bojen, Versorgung, Taverne“). */
export const COMPARISON_ATTRIBUTES = [
  "existence",
  "position",
  "shelter.N",
  "shelter.NE",
  "shelter.E",
  "shelter.SE",
  "shelter.S",
  "shelter.SW",
  "shelter.W",
  "shelter.NW",
  "depth",
  "seabed",
  "mooring.buoys",
  "services.water",
  "highlight.supply",
  "highlight.food",
] as const;
export type ComparisonAttribute = (typeof COMPARISON_ATTRIBUTES)[number];

/** The metrics of a quality snapshot (spec 10 „Qualitätsmetriken“ plus the pilot extras). */
export const METRIC_KEYS = [
  "coverage",
  "coverage_navily",
  "multi_source",
  "fact_precision",
  "quote_fidelity",
  "shelter_confidence",
  "route_reconstruction",
  "cost_per_place",
  "review_minutes",
  "review_minutes_per_100",
  "highlight_share",
  "recent_observation_share",
  "places_per_tile",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export const comparisonResultEnum = pgEnum("comparison_result", [
  "match",
  "deviation",
  "not_at_navily",
  "deviation_confirmed_own",
  "deviation_confirmed_navily",
  "unclear",
]);
export const comparisonMethodEnum = pgEnum("comparison_method", ["manual", "proposal_confirmed", "proposal_auto", "review"]);

export type ComparisonResultValue = (typeof comparisonResultEnum.enumValues)[number];
export type ComparisonMethod = (typeof comparisonMethodEnum.enumValues)[number];

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * One comparison outcome of an attribute of a place. `value_hash` identifies the own (normalised) value that was
 * compared, so an outcome stays valid as long as the value does (`comparisonValues`); the newest row per
 * `(place_id, attribute, value_hash)` is the current one.
 */
export const comparisonResults = pgTable(
  "comparison_results",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id),
    attribute: text("attribute").$type<ComparisonAttribute>().notNull(),
    /** The profile version compared; null for an evaluation profile. */
    profileVersion: integer("profile_version"),
    evaluationRunId: uuid("evaluation_run_id").references(() => runs.id),
    valueHash: text("value_hash").notNull(),
    result: comparisonResultEnum("result").notNull(),
    method: comparisonMethodEnum("method").notNull(),
    checkedBy: text("checked_by").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    reviewTaskId: uuid("review_task_id").references(() => reviewTasks.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("comparison_results_value_hash_format", sql`${t.valueHash} ~ '^[0-9a-f]{16}$'`),
    check("comparison_results_checked_by_length", sql`char_length(${t.checkedBy}) <= 120`),
    index("comparison_results_place_attribute_hash_idx").on(t.placeId, t.attribute, t.valueHash, t.checkedAt.desc()),
  ],
);

/** One metric of one scope (area or tile) of a measurement run; `value` null = not computable. */
export const qualitySnapshots = pgTable(
  "quality_snapshots",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    scopeType: text("scope_type").$type<"area" | "tile">().notNull(),
    scopeId: text("scope_id").notNull(),
    metric: text("metric").$type<MetricKey>().notNull(),
    value: doublePrecision("value"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    check("quality_snapshots_scope_type", sql`${t.scopeType} in ('area', 'tile')`),
    uniqueIndex("quality_snapshots_run_scope_metric_unique").on(t.runId, t.scopeType, t.scopeId, t.metric),
    index("quality_snapshots_scope_metric_created_idx").on(t.scopeType, t.scopeId, t.metric, t.createdAt.desc()),
  ],
);

/** A configuration version switched active after an evaluation run (spec 10 „Aktivieren ist ein bewusster Klick“). */
export const configActivations = pgTable(
  "config_activations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    kind: text("kind").$type<"consolidation_rules" | "extraction">().notNull(),
    version: text("version").notNull(),
    evaluationRunId: uuid("evaluation_run_id")
      .notNull()
      .references(() => runs.id),
    /** The old/new comparison the activation was based on. */
    comparison: jsonb("comparison").$type<Record<string, unknown>>().notNull(),
    activatedBy: text("activated_by").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("config_activations_kind", sql`${t.kind} in ('consolidation_rules', 'extraction')`)],
);
