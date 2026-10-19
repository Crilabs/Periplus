import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "@/lib/domain/ids";
import { geoObjects, tiles } from "./geo";
import { runs } from "./ops";
import { chunks, documentVersions, sources } from "./sources";

/*
 * Mentions, extraction and AI batches (spec 06).
 * - mentions (only extraction_status may change), routes, route_stops are append-only (forbid_mutation).
 * - ambiguous_matches, unmatched_names, name_candidates, extraction_runs, extraction_units, ai_batches,
 *   ai_batch_items, pipeline_passes are working state. Only ambiguous_matches, name_candidates and
 *   extraction_units have updated_at, maintained by set_updated_at.
 * - The document classification lives on document_versions (classified_* columns, ruling M4-P11).
 * Triggers: drizzle/0024_text_triggers.sql.
 */

export const matchKindEnum = pgEnum("match_kind", ["deterministic", "model", "review"]);
export const extractionStatusEnum = pgEnum("extraction_status", ["pending", "done", "skipped"]);
export const ambiguousStatusEnum = pgEnum("ambiguous_status", ["pending", "resolved", "none"]);
export const nameCandidateStatusEnum = pgEnum("name_candidate_status", ["collecting", "geocoded", "review", "decided"]);
export const extractionPurposeEnum = pgEnum("extraction_purpose", ["regular", "reprocess", "comparison"]);
export const extractionRunStatusEnum = pgEnum("extraction_run_status", ["running", "finished", "blocked", "failed"]);
export const unitStatusEnum = pgEnum("unit_status", ["pending", "submitted", "done", "failed"]);
export const mooringKindEnum = pgEnum("mooring_kind", ["anchor", "buoy", "quay", "marina", "unknown"]);
export const batchStatusEnum = pgEnum("batch_status", ["submitting", "submitted", "ended", "distributed", "failed"]);
export const batchItemStatusEnum = pgEnum("batch_item_status", ["pending", "succeeded", "failed", "retried"]);
export const comparisonVerdictEnum = pgEnum("comparison_verdict", [
  "a_correct",
  "b_correct",
  "both_ok",
  "both_wrong",
  "unclear",
]);

export type MatchKind = (typeof matchKindEnum.enumValues)[number];
export type ExtractionStatus = (typeof extractionStatusEnum.enumValues)[number];
export type AmbiguousStatus = (typeof ambiguousStatusEnum.enumValues)[number];
export type NameCandidateStatus = (typeof nameCandidateStatusEnum.enumValues)[number];
export type ExtractionPurpose = (typeof extractionPurposeEnum.enumValues)[number];
export type ExtractionRunStatus = (typeof extractionRunStatusEnum.enumValues)[number];
export type UnitStatus = (typeof unitStatusEnum.enumValues)[number];
export type MooringKind = (typeof mooringKindEnum.enumValues)[number];
export type BatchStatus = (typeof batchStatusEnum.enumValues)[number];
export type BatchItemStatus = (typeof batchItemStatusEnum.enumValues)[number];
export type ComparisonVerdict = (typeof comparisonVerdictEnum.enumValues)[number];

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const costEur = () => numeric("cost_eur", { precision: 12, scale: 6 });

/** A geo object named in a chunk. Append-only except `extraction_status`. */
export const mentions = pgTable(
  "mentions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => chunks.id),
    geoObjectId: uuid("geo_object_id")
      .notNull()
      .references(() => geoObjects.id),
    /** The wording in the chunk. */
    surface: text("surface").notNull(),
    // UTF-16 code unit offsets (JS string indices) into chunks.text.
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    typeHint: text("type_hint"),
    observedAt: date("observed_at").notNull(),
    confidence: real("confidence").notNull(),
    matchKind: matchKindEnum("match_kind").notNull(),
    matchScore: real("match_score"),
    /** Only for `match_kind model`. */
    model: text("model"),
    promptVersion: integer("prompt_version"),
    extractionStatus: extractionStatusEnum("extraction_status").notNull().default("pending"),
    runId: uuid("run_id").references(() => runs.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("mentions_confidence_range", sql`${t.confidence} between 0 and 1`),
    uniqueIndex("mentions_chunk_geo_object_char_start_unique").on(t.chunkId, t.geoObjectId, t.charStart),
    index("mentions_geo_object_id_idx").on(t.geoObjectId),
    index("mentions_document_version_id_idx").on(t.documentVersionId),
  ],
);

/** Working state: a name with several candidate objects, waiting for disambiguation. */
export const ambiguousMatches = pgTable(
  "ambiguous_matches",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => chunks.id),
    surface: text("surface").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    typeHint: text("type_hint"),
    /** `[{ geoObjectId, similarity }]` */
    candidates: jsonb("candidates").notNull(),
    status: ambiguousStatusEnum("status").notNull().default("pending"),
    runId: uuid("run_id").references(() => runs.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ambiguous_matches_chunk_span_unique").on(t.chunkId, t.charStart, t.charEnd)],
);

/** Working state: a place-like name in a chunk without any gazetteer match. */
export const unmatchedNames = pgTable(
  "unmatched_names",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    nameNormalized: text("name_normalized").notNull(),
    displayName: text("display_name").notNull(),
    hint: text("hint"),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => chunks.id),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    tileId: text("tile_id").references(() => tiles.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("unmatched_names_name_chunk_unique").on(t.nameNormalized, t.chunkId)],
);

/** Working state: an unmatched name seen often enough in one tile to be geocoded and reviewed. */
export const nameCandidates = pgTable(
  "name_candidates",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    nameNormalized: text("name_normalized").notNull(),
    displayName: text("display_name").notNull(),
    hint: text("hint"),
    tileId: text("tile_id")
      .notNull()
      .references(() => tiles.id),
    status: nameCandidateStatusEnum("status").notNull().default("collecting"),
    documents: integer("documents").notNull().default(0),
    sources: integer("sources").notNull().default(0),
    geocode: jsonb("geocode"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("name_candidates_name_tile_unique").on(t.nameNormalized, t.tileId)],
);

/** Working state: one extraction pass of a model over the units of a run (`task` extract-facts | extract-route). */
export const extractionRuns = pgTable(
  "extraction_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    task: text("task").notNull(),
    model: text("model").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    factSchemaVersion: text("fact_schema_version").notNull(),
    purpose: extractionPurposeEnum("purpose").notNull().default("regular"),
    /** No foreign key yet: model_comparisons arrives with Task 19. */
    comparisonId: uuid("comparison_id"),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    status: extractionRunStatusEnum("status").notNull().default("running"),
    stats: jsonb("stats").notNull().default({}),
    quoteCheck: jsonb("quote_check"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("extraction_runs_run_task_model_unique").on(t.runId, t.task, t.model)],
);

/** Working state: one model request of an extraction run, (document version, geo object, part). */
export const extractionUnits = pgTable(
  "extraction_units",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    extractionRunId: uuid("extraction_run_id")
      .notNull()
      .references(() => extractionRuns.id),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id),
    geoObjectId: uuid("geo_object_id")
      .notNull()
      .references(() => geoObjects.id),
    part: integer("part").notNull(),
    level: text("level").notNull(),
    mentionIds: uuid("mention_ids").array().notNull().default([]),
    chunkIds: uuid("chunk_ids").array().notNull().default([]),
    status: unitStatusEnum("status").notNull().default("pending"),
    stats: jsonb("stats"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costEur: costEur(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("extraction_units_run_version_object_part_unique").on(
      t.extractionRunId,
      t.documentVersionId,
      t.geoObjectId,
      t.part,
    ),
  ],
);

/** Append-only: the route of a trip report, reconstructed by one extraction run. */
export const routes = pgTable(
  "routes",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id),
    extractionRunId: uuid("extraction_run_id")
      .notNull()
      .references(() => extractionRuns.id),
    stopsCount: integer("stops_count").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("routes_version_extraction_run_unique").on(t.documentVersionId, t.extractionRunId)],
);

/** Append-only: one stop of a route, always with a verified verbatim quote. */
export const routeStops = pgTable(
  "route_stops",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    routeId: uuid("route_id")
      .notNull()
      .references(() => routes.id),
    ordinal: integer("ordinal").notNull(),
    name: text("name").notNull(),
    geoObjectId: uuid("geo_object_id").references(() => geoObjects.id),
    mentionId: uuid("mention_id").references(() => mentions.id),
    date: date("date"),
    mooring: mooringKindEnum("mooring").notNull().default("unknown"),
    quote: text("quote").notNull(),
    quoteVerified: boolean("quote_verified").notNull(),
    quoteChunkId: uuid("quote_chunk_id")
      .notNull()
      .references(() => chunks.id),
    leg: jsonb("leg"),
    createdAt: createdAt(),
  },
  (t) => [
    check("route_stops_quote_verified", sql`${t.quoteVerified} = true`),
    uniqueIndex("route_stops_route_ordinal_unique").on(t.routeId, t.ordinal),
  ],
);

/** Working state: one provider message batch for one stage unit (`outcome_key`) of a run. */
export const aiBatches = pgTable(
  "ai_batches",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    /** Null until submitted. */
    providerBatchId: text("provider_batch_id").unique(),
    task: text("task").notNull(),
    model: text("model").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    status: batchStatusEnum("status").notNull().default("submitting"),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    stage: text("stage").notNull(),
    outcomeKey: text("outcome_key").notNull(),
    pollCount: integer("poll_count").notNull().default(0),
    requestCount: integer("request_count").notNull(),
    /** Budget reservation until the batch is booked (ruling M4-P6). */
    estimatedCostEur: numeric("estimated_cost_eur", { precision: 12, scale: 6 }),
    costEur: costEur(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // At most one open batch per stage unit.
    uniqueIndex("ai_batches_open_outcome_unique")
      .on(t.runId, t.stage, t.outcomeKey)
      .where(sql`${t.status} not in ('distributed', 'failed')`),
  ],
);

/** Working state: one request of a batch; `id` is the provider `custom_id`. */
export const aiBatchItems = pgTable(
  "ai_batch_items",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => aiBatches.id),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    input: jsonb("input").notNull(),
    status: batchItemStatusEnum("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(1),
    output: jsonb("output"),
    error: text("error"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costEur: costEur(),
    distributedAt: timestamp("distributed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("ai_batch_items_batch_id_idx").on(t.batchId)],
);

/** Working state: a document version has passed `stage` with configuration `config_key`. */
export const pipelinePasses = pgTable(
  "pipeline_passes",
  {
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id),
    stage: text("stage").notNull(),
    configKey: text("config_key").notNull(),
    runId: uuid("run_id").references(() => runs.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.documentVersionId, t.stage, t.configKey] })],
);
