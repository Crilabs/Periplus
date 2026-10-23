import { boolean, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { newId } from "@/lib/domain/ids";
import { geoObjects, places } from "./geo";
import { runs } from "./ops";
import { documentVersions, observedAtBasisEnum, serpQueries, serpResults } from "./sources";

/*
 * Per-berth research (spec 18, plan N1).
 * - research_hits: which result of which search belongs to which candidate, positive or negative search.
 * - page_assessments: what the model found on one archived page version (kind, first-hand, berths named).
 */

export const researchPurposeEnum = pgEnum("research_purpose", ["positive", "negative"]);
export const pageKindEnum = pgEnum("page_kind", [
  "trip_report",
  "pilot_guide",
  "marina",
  "authority",
  "forum",
  "travel_guide",
  "listing",
  "other",
]);
export type ResearchPurpose = (typeof researchPurposeEnum.enumValues)[number];
export type PageKind = (typeof pageKindEnum.enumValues)[number];

export type AssessedBerthKind = "anchorage" | "mooring_field" | "marina" | "port" | "unknown";
/** A berth a page talks about, as the model named it. */
export type AssessedBerth = { name: string; island: string | null; kind: AssessedBerthKind };

export const researchHits = pgTable(
  "research_hits",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id),
    geoObjectId: uuid("geo_object_id")
      .notNull()
      .references(() => geoObjects.id),
    serpQueryId: uuid("serp_query_id")
      .notNull()
      .references(() => serpQueries.id),
    serpResultId: uuid("serp_result_id")
      .notNull()
      .references(() => serpResults.id),
    urlNormalized: text("url_normalized").notNull(),
    domain: text("domain").notNull(),
    rank: integer("rank").notNull(),
    purpose: researchPurposeEnum("purpose").notNull(),
    runId: uuid("run_id").references(() => runs.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("research_hits_place_id_url_normalized_purpose_unique").on(t.placeId, t.urlNormalized, t.purpose),
    index("research_hits_url_normalized_idx").on(t.urlNormalized),
  ],
);

export const pageAssessments = pgTable(
  "page_assessments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id),
    model: text("model").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    pageKind: pageKindEnum("page_kind").notNull(),
    firstHand: boolean("first_hand").notNull(),
    /** SEO or AI generated text. */
    generated: boolean("generated").notNull(),
    language: text("language"),
    observedAt: date("observed_at").notNull(),
    observedAtBasis: observedAtBasisEnum("observed_at_basis").notNull(),
    observedAtReason: text("observed_at_reason"),
    berths: jsonb("berths").$type<AssessedBerth[]>().notNull(),
    runId: uuid("run_id").references(() => runs.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("page_assessments_version_model_prompt_unique").on(
      t.documentVersionId,
      t.model,
      t.promptVersion,
    ),
  ],
);

export const researchFetchOutcomeEnum = pgEnum("research_fetch_outcome", ["stored", "unchanged", "skipped", "gone", "failed"]);
export type ResearchFetchOutcome = (typeof researchFetchOutcomeEnum.enumValues)[number];

/** Append-only: what the fetch of one hit URL came to in a run (one row per attempt; the newest is the current one). */
export const researchFetches = pgTable(
  "research_fetches",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    urlNormalized: text("url_normalized").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    outcome: researchFetchOutcomeEnum("outcome").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("research_fetches_url_normalized_created_at_idx").on(t.urlNormalized, t.createdAt), index("research_fetches_run_id_idx").on(t.runId)],
);
