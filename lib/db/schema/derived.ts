import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
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
import { chunks } from "./sources";
import { extractionRuns, mentions } from "./text";

/*
 * Derived data. computations and facts are append-only (forbid_mutation trigger,
 * drizzle/0011_derived_triggers.sql): a new value is a new row, never an update.
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

/** A value about a geo object with exactly one basis: mention (with quote), computation, observation or review. */
export const facts = pgTable(
  "facts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    geoObjectId: uuid("geo_object_id")
      .notNull()
      .references(() => geoObjects.id),
    attribute: text("attribute").notNull(),
    value: jsonb("value").notNull(),
    mentionId: uuid("mention_id").references(() => mentions.id),
    computationId: uuid("computation_id").references(() => computations.id),
    /** No foreign key yet: the observations table arrives in M8. */
    observationId: uuid("observation_id"),
    reviewDecisionId: uuid("review_decision_id").references(() => reviewDecisions.id),
    quote: text("quote"),
    quoteVerified: boolean("quote_verified").notNull().default(false),
    /** Where the verified quote lies: chunk and UTF-16 offsets into chunks.text (for highlighting). */
    quoteChunkId: uuid("quote_chunk_id").references(() => chunks.id),
    quoteStart: integer("quote_start"),
    quoteEnd: integer("quote_end"),
    observedAt: date("observed_at").notNull(),
    confidence: real("confidence").notNull(),
    extractionRunId: uuid("extraction_run_id").references(() => extractionRuns.id),
    factSchemaVersion: text("fact_schema_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "facts_one_basis",
      sql`num_nonnulls(${t.mentionId}, ${t.computationId}, ${t.observationId}, ${t.reviewDecisionId}) = 1`,
    ),
    check("facts_quote_for_mention", sql`${t.mentionId} is null or ${t.quote} is not null`),
    // No text fact without a verified, located quote.
    check(
      "facts_text_quote_verified",
      sql`${t.mentionId} is null or (${t.quoteVerified} and ${t.quoteChunkId} is not null)`,
    ),
    check("facts_text_extraction_run", sql`${t.mentionId} is null or ${t.extractionRunId} is not null`),
    // The located quote: offsets into quote_chunk_id's text, end exclusive.
    check(
      "facts_text_quote_span",
      sql`${t.mentionId} is null or (${t.quoteStart} is not null and ${t.quoteEnd} is not null and ${t.quoteStart} >= 0 and ${t.quoteStart} < ${t.quoteEnd})`,
    ),
    check("facts_confidence_range", sql`${t.confidence} between 0 and 1`),
    uniqueIndex("facts_mention_attribute_run_unique").on(t.mentionId, t.attribute, t.extractionRunId),
    uniqueIndex("facts_computation_attribute_unique")
      .on(t.computationId, t.attribute)
      .where(sql`${t.computationId} is not null`),
    uniqueIndex("facts_review_decision_attribute_unique")
      .on(t.reviewDecisionId, t.attribute)
      .where(sql`${t.reviewDecisionId} is not null`),
    index("facts_geo_object_attribute_observed_idx").on(t.geoObjectId, t.attribute, t.observedAt),
    // The facts of an extraction run (the targets of a text run's consolidation, ruling M5-H-R2).
    index("facts_extraction_run_id_idx").on(t.extractionRunId),
  ],
);
