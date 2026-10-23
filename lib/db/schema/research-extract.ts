import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { newId } from "@/lib/domain/ids";
import { places } from "./geo";
import { runs } from "./ops";
import { documentVersions, observedAtBasisEnum } from "./sources";

/*
 * Extraction and confirmation per berth (spec 18, plan N2). One research unit is one page version read for one place;
 * facts, signals and landing hints are append-only rows under it, each with a located quote.
 */

export const researchUnitStatusEnum = pgEnum("research_unit_status", ["pending", "done", "failed", "skipped"]);
export const berthSignalKindEnum = pgEnum("berth_signal_kind", [
  "anchored",
  "moored_buoy",
  "berthed",
  "listed_as_berth",
  "prohibited",
  "buoys_private",
  "no_space",
  "unsafe",
  "closed",
]);
export const toneEnum = pgEnum("tone", ["positive", "negative", "neutral"]);
export type ResearchUnitStatus = (typeof researchUnitStatusEnum.enumValues)[number];
export type BerthSignalKind = (typeof berthSignalKindEnum.enumValues)[number];
export type Tone = (typeof toneEnum.enumValues)[number];

/** How many model deliveries were dropped, by reason (`attribution`: the quote names another berth of the page, not this one). */
export type DroppedCounts = { quote: number; value: number; verbatim: number; attribution: number };

export const researchUnits = pgTable(
  "research_units",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id),
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id),
    model: text("model").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    status: researchUnitStatusEnum("status").notNull(),
    reason: text("reason"),
    dropped: jsonb("dropped").$type<DroppedCounts>().notNull(),
    /** How often the unit's item failed; a failed unit is planned again below `research.extraction.maxAttempts`. */
    attempts: integer("attempts").notNull().default(0),
    runId: uuid("run_id").references(() => runs.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("research_units_version_place_model_prompt_unique").on(t.documentVersionId, t.placeId, t.model, t.promptVersion),
    index("research_units_place_id_idx").on(t.placeId),
  ],
);

export const berthFacts = pgTable(
  "berth_facts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => researchUnits.id),
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id),
    attribute: text("attribute"),
    value: jsonb("value"),
    statement: text("statement"),
    subjectName: text("subject_name"),
    subjectCategory: text("subject_category"),
    quote: text("quote").notNull(),
    quoteStart: integer("quote_start").notNull(),
    quoteEnd: integer("quote_end").notNull(),
    observedAt: date("observed_at").notNull(),
    observedAtBasis: observedAtBasisEnum("observed_at_basis").notNull(),
    tone: toneEnum("tone"),
    safety: boolean("safety").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Either a structured fact (attribute and value) or a free statement, never both and never neither.
    check(
      "berth_facts_shape_check",
      sql`(${t.attribute} is not null and ${t.value} is not null and ${t.statement} is null) or (${t.attribute} is null and ${t.value} is null and ${t.statement} is not null)`,
    ),
    index("berth_facts_place_id_idx").on(t.placeId),
    index("berth_facts_unit_id_idx").on(t.unitId),
  ],
);

export const berthSignals = pgTable(
  "berth_signals",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => researchUnits.id),
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id),
    kind: berthSignalKindEnum("kind").notNull(),
    firstHand: boolean("first_hand").notNull(),
    confidence: real("confidence").notNull(),
    quote: text("quote").notNull(),
    quoteStart: integer("quote_start").notNull(),
    quoteEnd: integer("quote_end").notNull(),
    observedAt: date("observed_at").notNull(),
    observedAtBasis: observedAtBasisEnum("observed_at_basis").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("berth_signals_confidence_check", sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
    index("berth_signals_place_id_idx").on(t.placeId),
    index("berth_signals_unit_id_idx").on(t.unitId),
  ],
);

export const landingHints = pgTable(
  "landing_hints",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => researchUnits.id),
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id),
    description: text("description").notNull(),
    quote: text("quote").notNull(),
    quoteStart: integer("quote_start").notNull(),
    quoteEnd: integer("quote_end").notNull(),
    observedAt: date("observed_at").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("landing_hints_place_id_idx").on(t.placeId), index("landing_hints_unit_id_idx").on(t.unitId)],
);

export const researchRouteStops = pgTable(
  "research_route_stops",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id),
    seq: integer("seq").notNull(),
    name: text("name").notNull(),
    mooringKind: text("mooring_kind"),
    quote: text("quote").notNull(),
    observedAt: date("observed_at").notNull(),
    /** The place the stop was assigned to; null while unassigned. */
    placeId: uuid("place_id").references(() => places.id),
    /** How it was assigned: by name or by the route corridor. */
    match: text("match"),
    model: text("model").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("research_route_stops_version_seq_model_prompt_unique").on(t.documentVersionId, t.seq, t.model, t.promptVersion),
    check("research_route_stops_match_check", sql`${t.match} is null or ${t.match} in ('name', 'corridor')`),
    index("research_route_stops_place_id_idx").on(t.placeId),
  ],
);
