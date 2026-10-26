import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "@/lib/domain/ids";
import { geoObjects } from "./geo";
import { runs } from "./ops";
import { reviewDecisions } from "./review";

/*
 * Derived data. computations and facts are written as new rows; since N6 (design 7.2) no trigger protects them against
 * change or delete. Text facts of the old pipeline are gone (drizzle/0080_drop_old_pipeline.sql); the researched facts
 * live in berth_facts and berth_states.
 */

export const computationKindEnum = pgEnum("computation_kind", [
  "shelter",
  "fetch",
  "depth",
  "seabed",
  "anchor_area",
  "quietness",
  "restriction",
]);

export type ComputationKind = (typeof computationKindEnum.enumValues)[number];

/** One geometric computation per geo object and kind; identical inputs as the last run write no new row. */
export const computations = pgTable(
  "computations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    geoObjectId: uuid("geo_object_id")
      .notNull()
      .references(() => geoObjects.id),
    kind: computationKindEnum("kind").notNull(),
    inputs: jsonb("inputs").notNull(),
    inputsHash: text("inputs_hash").notNull(),
    /** Intermediate results without a fact of their own: rays, areas, gaps. */
    outputs: jsonb("outputs").notNull().default({}),
    rulesVersion: text("rules_version").notNull(),
    runId: uuid("run_id").references(() => runs.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("computations_geo_object_kind_created_idx").on(t.geoObjectId, t.kind, t.createdAt.desc())],
);

/** A value about a geo object with exactly one basis: computation, observation or review. */
export const facts = pgTable(
  "facts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    geoObjectId: uuid("geo_object_id")
      .notNull()
      .references(() => geoObjects.id),
    attribute: text("attribute").notNull(),
    value: jsonb("value").notNull(),
    computationId: uuid("computation_id").references(() => computations.id),
    /** No foreign key yet: the observations table arrives in M8. */
    observationId: uuid("observation_id"),
    reviewDecisionId: uuid("review_decision_id").references(() => reviewDecisions.id),
    quote: text("quote"),
    quoteVerified: boolean("quote_verified").notNull().default(false),
    observedAt: date("observed_at").notNull(),
    confidence: real("confidence").notNull(),
    factSchemaVersion: text("fact_schema_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("facts_one_basis", sql`num_nonnulls(${t.computationId}, ${t.observationId}, ${t.reviewDecisionId}) = 1`),
    check("facts_confidence_range", sql`${t.confidence} between 0 and 1`),
    uniqueIndex("facts_computation_attribute_unique")
      .on(t.computationId, t.attribute)
      .where(sql`${t.computationId} is not null`),
    uniqueIndex("facts_review_decision_attribute_unique")
      .on(t.reviewDecisionId, t.attribute)
      .where(sql`${t.reviewDecisionId} is not null`),
    index("facts_geo_object_attribute_observed_idx").on(t.geoObjectId, t.attribute, t.observedAt),
  ],
);
