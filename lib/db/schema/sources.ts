import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { newId } from "@/lib/domain/ids";
import { geoObjects, places } from "./geo";
import { runs } from "./ops";

/*
 * Sources and archive (spec 05).
 * - document_versions is the append-only archive (forbid_mutation, drizzle/0017 and 0024; only the classified_* columns
 *   may change, ruling M4-P11). Since N6 (design 7.2) sources and documents carry no delete or history protection;
 *   updated_at is maintained by set_updated_at. Chunks, crawl front, link graph and converter comparison
 *   went with the old pipeline (drizzle/0080_drop_old_pipeline.sql).
 */

export const docTypeEnum = pgEnum("doc_type", [
  "pilot_guide",
  "trip_report",
  "forum",
  "marina",
  "authority",
  "dataset",
  "travel_guide",
  "other",
]);
export const sourceStatusEnum = pgEnum("source_status", ["proposed", "approved", "rejected", "paused"]);
export const sourceFormatEnum = pgEnum("source_format", ["html", "pdf", "table", "geodata"]);
export const changeRateEnum = pgEnum("change_rate", ["high", "normal", "static"]);
export const sourceOriginEnum = pgEnum("source_origin", ["serp", "linkgraph", "whitelist", "manual", "place_website", "research"]);
export const documentStatusEnum = pgEnum("document_status", ["active", "gone"]);
export const observedAtBasisEnum = pgEnum("observed_at_basis", ["explicit", "published", "fetched"]);

export const DOC_TYPES = docTypeEnum.enumValues;
export type DocType = (typeof docTypeEnum.enumValues)[number];
export type SourceStatus = (typeof sourceStatusEnum.enumValues)[number];
export type SourceFormat = (typeof sourceFormatEnum.enumValues)[number];
export type ChangeRate = (typeof changeRateEnum.enumValues)[number];
export type SourceOrigin = (typeof sourceOriginEnum.enumValues)[number];
export type DocumentStatus = (typeof documentStatusEnum.enumValues)[number];
export type ObservedAtBasis = (typeof observedAtBasisEnum.enumValues)[number];

const validFrom = () => date("valid_from").notNull().default(sql`current_date`);
const validTo = () => date("valid_to");
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    /** Registrable domain (Public Suffix List), e.g. `example.co.uk`. */
    domain: text("domain").notNull(),
    name: text("name").notNull(),
    type: docTypeEnum("type").notNull(),
    format: sourceFormatEnum("format").notNull().default("html"),
    languages: text("languages").array().notNull().default([]),
    weight: real("weight").notNull(),
    status: sourceStatusEnum("status").notNull().default("proposed"),
    statusReason: text("status_reason"),
    /** Spec 05 crawl rules (startUrls, allow, deny, maxDepth, …), validated by the application. */
    crawlRules: jsonb("crawl_rules").notNull(),
    changeRate: changeRateEnum("change_rate").notNull().default("normal"),
    origin: sourceOriginEnum("origin").notNull(),
    validFrom: validFrom(),
    validTo: validTo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sources_domain_valid_unique").on(t.domain).where(sql`${t.validTo} is null`),
    check("sources_weight_range", sql`${t.weight} between 0 and 1`),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    url: text("url").notNull(),
    urlNormalized: text("url_normalized").notNull(),
    docType: docTypeEnum("doc_type").notNull(),
    status: documentStatusEnum("status").notNull().default("active"),
    /** Consecutive 404/410 answers; at 2 the document becomes `gone`. */
    consecutiveGone: integer("consecutive_gone").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    etag: text("etag"),
    lastModified: text("last_modified"),
    currentVersionId: uuid("current_version_id").references((): AnyPgColumn => documentVersions.id),
    validFrom: validFrom(),
    validTo: validTo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("documents_url_normalized_unique").on(t.urlNormalized),
    index("documents_source_id_idx").on(t.sourceId),
  ],
);

/** One archived version per distinct content (`content_hash` = SHA-256 of the normalised Markdown). */
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    documentId: uuid("document_id")
      .notNull()
      .references((): AnyPgColumn => documents.id),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    contentHash: text("content_hash").notNull(),
    rawHash: text("raw_hash").notNull(),
    rawKey: text("raw_key").notNull(),
    mdKey: text("md_key").notNull(),
    diffKey: text("diff_key"),
    contentType: text("content_type"),
    finalUrl: text("final_url"),
    language: text("language"),
    publishedAt: date("published_at"),
    observedAt: date("observed_at").notNull(),
    observedAtBasis: observedAtBasisEnum("observed_at_basis").notNull(),
    docType: docTypeEnum("doc_type").notNull(),
    converter: text("converter").notNull(),
    simulated: boolean("simulated").notNull().default(false),
    charCount: integer("char_count").notNull(),
    runId: uuid("run_id").references(() => runs.id),
    createdAt: createdAt(),
    /*
     * Model classification (spec 06, ruling M4-P11): technical columns, the only ones the append-only trigger
     * releases (drizzle/0024_text_triggers.sql). The fetch-time columns above never change; readers prefer these.
     */
    classifiedDocType: docTypeEnum("classified_doc_type"),
    classifiedLanguages: text("classified_languages").array(),
    classifiedPublishedAt: date("classified_published_at"),
    classifiedObservedAt: date("classified_observed_at"),
    classifiedObservedAtBasis: observedAtBasisEnum("classified_observed_at_basis"),
    observedAtReason: text("observed_at_reason"),
    areaHints: text("area_hints").array(),
    classifiedModel: text("classified_model"),
    classifiedPromptVersion: integer("classified_prompt_version"),
    classifiedRunId: uuid("classified_run_id").references(() => runs.id),
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("document_versions_document_id_content_hash_unique").on(t.documentId, t.contentHash)],
);

export const serpLevelEnum = pgEnum("serp_level", ["area", "tile", "place", "place_website", "research"]);
export type SerpLevel = (typeof serpLevelEnum.enumValues)[number];

/** Working state: one row per SERP search actually made (a reused query writes none); raw answer in S3. */
export const serpQueries = pgTable(
  "serp_queries",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    keyword: text("keyword").notNull(),
    languageCode: text("language_code").notNull(),
    locationCode: integer("location_code").notNull(),
    depth: integer("depth").notNull(),
    level: serpLevelEnum("level").notNull(),
    /** Area key (`level area`), tile id (`level tile`) or geo object id (`level place`, ruling M5-P12). */
    scopeId: text("scope_id").notNull(),
    /** `serp/<YYYY-MM-DD>/<sha256(keyword|language|location)>.json` */
    rawKey: text("raw_key").notNull(),
    runId: uuid("run_id").references(() => runs.id),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("serp_queries_keyword_language_location_fetched_idx").on(
      t.keyword,
      t.languageCode,
      t.locationCode,
      t.fetchedAt.desc(),
    ),
  ],
);

/** Working state: the organic results of one SERP search, by absolute rank. */
export const serpResults = pgTable(
  "serp_results",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    serpQueryId: uuid("serp_query_id")
      .notNull()
      .references(() => serpQueries.id),
    rank: integer("rank").notNull(),
    url: text("url").notNull(),
    urlNormalized: text("url_normalized").notNull(),
    /** Registrable domain (Public Suffix List, private suffixes included). */
    domain: text("domain").notNull(),
    title: text("title").notNull(),
    snippet: text("snippet").notNull(),
  },
  (t) => [index("serp_results_domain_idx").on(t.domain), index("serp_results_serp_query_id_idx").on(t.serpQueryId)],
);

export const placeWebsiteOriginEnum = pgEnum("place_website_origin", ["osm", "wikidata", "serp"]);
export type PlaceWebsiteOrigin = (typeof placeWebsiteOriginEnum.enumValues)[number];

/**
 * Append-only: the official website of a place and where it came from (spec 15 C). The current website of a place is
 * its newest row; `bound` marks a row whose domain became (or already was) a source bound to the place.
 */
export const placeWebsites = pgTable(
  "place_websites",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id),
    geoObjectId: uuid("geo_object_id")
      .notNull()
      .references(() => geoObjects.id),
    url: text("url").notNull(),
    urlNormalized: text("url_normalized").notNull(),
    origin: placeWebsiteOriginEnum("origin").notNull(),
    serpQueryId: uuid("serp_query_id").references(() => serpQueries.id),
    quote: text("quote"),
    confidence: real("confidence"),
    sourceId: uuid("source_id").references(() => sources.id),
    bound: boolean("bound").notNull(),
    runId: uuid("run_id").references(() => runs.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("place_websites_place_id_created_at_idx").on(t.placeId, t.createdAt.desc()),
    index("place_websites_url_normalized_idx").on(t.urlNormalized),
  ],
);
