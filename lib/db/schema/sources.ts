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
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { newId } from "@/lib/domain/ids";
import { runs } from "./ops";

/*
 * Sources and archive (spec 05).
 * - sources, documents are stable: never deleted (forbid_delete), end via valid_to; core-column changes write
 *   <table>_history (record_history); updated_at maintained by set_updated_at.
 * - document_versions is append-only (forbid_mutation('')); chunks is append-only except embedding and
 *   embedding_model (forbid_mutation('embedding,embedding_model')).
 * - text_shingles, crawl_frontier are working state.
 * Triggers and history tables: drizzle/0017_sources_triggers.sql.
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
export const sourceOriginEnum = pgEnum("source_origin", ["serp", "linkgraph", "whitelist", "manual"]);
export const documentStatusEnum = pgEnum("document_status", ["active", "gone"]);
export const observedAtBasisEnum = pgEnum("observed_at_basis", ["explicit", "published", "fetched"]);
export const frontierStatusEnum = pgEnum("frontier_status", ["queued", "fetched", "skipped", "failed"]);

export const DOC_TYPES = docTypeEnum.enumValues;
export type DocType = (typeof docTypeEnum.enumValues)[number];
export type SourceStatus = (typeof sourceStatusEnum.enumValues)[number];
export type SourceFormat = (typeof sourceFormatEnum.enumValues)[number];
export type ChangeRate = (typeof changeRateEnum.enumValues)[number];
export type SourceOrigin = (typeof sourceOriginEnum.enumValues)[number];
export type DocumentStatus = (typeof documentStatusEnum.enumValues)[number];
export type ObservedAtBasis = (typeof observedAtBasisEnum.enumValues)[number];
export type FrontierStatus = (typeof frontierStatusEnum.enumValues)[number];

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
  },
  (t) => [uniqueIndex("document_versions_document_id_content_hash_unique").on(t.documentId, t.contentHash)],
);

/** Dimension = `config/embeddings.json` `dimension`; checked at worker start. */
export const EMBEDDING_DIMENSION = 1024;

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    /** Lower case, without accents; search key (trigram index). */
    textNormalized: text("text_normalized").notNull(),
    textHash: text("text_hash").notNull(),
    heading: text("heading"),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    wordCount: integer("word_count").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSION }),
    embeddingModel: text("embedding_model"),
    /** Unchanged chunk taken over from the previous version. */
    carriedFromChunkId: uuid("carried_from_chunk_id").references((): AnyPgColumn => chunks.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("chunks_document_version_id_ordinal_unique").on(t.documentVersionId, t.ordinal),
    index("chunks_text_hash_idx").on(t.textHash),
    index("chunks_text_normalized_trgm").using("gin", t.textNormalized.op("gin_trgm_ops")),
    index("chunks_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

/** Working state: shingle hashes per chunk for near-duplicate detection. */
export const textShingles = pgTable(
  "text_shingles",
  {
    shingleHash: bigint("shingle_hash", { mode: "bigint" }).notNull(),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => chunks.id),
  },
  (t) => [primaryKey({ columns: [t.shingleHash, t.chunkId] }), index("text_shingles_chunk_id_idx").on(t.chunkId)],
);

/** Working state: URLs discovered per source and their crawl status. */
export const crawlFrontier = pgTable(
  "crawl_frontier",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    url: text("url").notNull(),
    urlNormalized: text("url_normalized").notNull(),
    depth: integer("depth").notNull().default(0),
    status: frontierStatusEnum("status").notNull().default("queued"),
    reason: text("reason"),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
    lastRunId: uuid("last_run_id").references(() => runs.id),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("crawl_frontier_source_id_url_normalized_unique").on(t.sourceId, t.urlNormalized)],
);

export const serpLevelEnum = pgEnum("serp_level", ["area", "tile"]);
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
    /** Area key (`level area`) or tile id (`level tile`). */
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

/** Working state: outgoing links per approved source, target registrable domain and crawl run (link graph). */
export const outlinks = pgTable(
  "outlinks",
  {
    fromSourceId: uuid("from_source_id")
      .notNull()
      .references(() => sources.id),
    /** Registrable domain (Public Suffix List, private suffixes included). */
    toDomain: text("to_domain").notNull(),
    count: integer("count").notNull().default(0),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
  },
  (t) => [
    primaryKey({ columns: [t.fromSourceId, t.toDomain, t.runId] }),
    index("outlinks_to_domain_idx").on(t.toDomain),
  ],
);
