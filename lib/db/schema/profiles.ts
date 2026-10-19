import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  customType,
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
} from "drizzle-orm/pg-core";
import type { AttributeProvenance, ConflictNote, ProfileGap } from "@/lib/domain/consolidation/types";
import { newId } from "@/lib/domain/ids";
import { geoObjects } from "./geo";
import { runs } from "./ops";

/*
 * Consolidated profiles (spec 07). profiles, change_events and profile_summaries are append-only
 * (forbid_mutation trigger, drizzle/0032_profile_triggers.sql); evaluation_profiles,
 * place_discovery_requests and wikidata_sitelinks are working state.
 */

export const changeTypeEnum = pgEnum("change_type", [
  "new_attribute",
  "changed",
  "uncertain",
  "expired",
  "place_new",
  "place_abandoned",
  "geo_changed",
]);
export const changeSeverityEnum = pgEnum("change_severity", ["info", "notable", "safety"]);
export const summaryStatusEnum = pgEnum("summary_status", ["ok", "rejected", "empty"]);

export type ChangeType = (typeof changeTypeEnum.enumValues)[number];
export type ChangeSeverity = (typeof changeSeverityEnum.enumValues)[number];
export type SummaryStatus = (typeof summaryStatusEnum.enumValues)[number];

/** Postgres `xid8` (transaction id); the driver returns it as a decimal string. */
const xid8 = customType<{ data: string; driverData: string }>({ dataType: () => "xid8" });

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** One profile version per geo object; a new version only when values or confidence classes change. */
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    geoObjectId: uuid("geo_object_id")
      .notNull()
      .references(() => geoObjects.id),
    version: integer("version").notNull(),
    /** Date of the run that wrote the version; `profileAsOf` reads by it. */
    validFrom: date("valid_from").notNull(),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull(),
    provenance: jsonb("provenance").$type<Record<string, AttributeProvenance>>().notNull(),
    conflicts: jsonb("conflicts").$type<ConflictNote[]>().notNull().default([]),
    gaps: jsonb("gaps").$type<ProfileGap[]>().notNull().default([]),
    sourcesCount: integer("sources_count").notNull(),
    documentsCount: integer("documents_count").notNull(),
    /** Weighted mean over shelter, depth, seabed and exclusion; null when none of them has a value. */
    confidence: real("confidence"),
    contentHash: text("content_hash").notNull(),
    factSchemaVersion: text("fact_schema_version").notNull(),
    rulesVersion: text("rules_version").notNull(),
    runId: uuid("run_id").references(() => runs.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("profiles_version_positive", sql`${t.version} >= 1`),
    check("profiles_confidence_range", sql`${t.confidence} between 0 and 1`),
    uniqueIndex("profiles_geo_object_version_unique").on(t.geoObjectId, t.version),
    index("profiles_geo_object_valid_from_idx").on(t.geoObjectId, t.validFrom.desc(), t.version.desc()),
  ],
);

/** The change feed; `seq` is its cursor. `profile_version` is null for events without a version (`place_abandoned` …). */
export const changeEvents = pgTable(
  "change_events",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    seq: bigserial("seq", { mode: "number" }).notNull().unique("change_events_seq_unique"),
    geoObjectId: uuid("geo_object_id")
      .notNull()
      .references(() => geoObjects.id),
    profileVersion: integer("profile_version"),
    type: changeTypeEnum("type").notNull(),
    attribute: text("attribute"),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    severity: changeSeverityEnum("severity").notNull(),
    details: jsonb("details").notNull().default({}),
    runId: uuid("run_id").references(() => runs.id),
    /**
     * Transaction that wrote the row (outbox guard, ruling M5-A-R2): `seq` is assigned at insert, not at commit, so a
     * reader of the feed must only return rows passing `visibleChangeEventsFilter` (lib/domain/change-feed.ts).
     */
    xactId: xid8("xact_id").notNull().default(sql`pg_current_xact_id()`),
    createdAt: createdAt(),
  },
  (t) => [index("change_events_geo_object_seq_idx").on(t.geoObjectId, t.seq)],
);

/** Generated summaries of a profile version; `text` is null for `empty`. */
export const profileSummaries = pgTable(
  "profile_summaries",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    geoObjectId: uuid("geo_object_id")
      .notNull()
      .references(() => geoObjects.id),
    profileVersion: integer("profile_version").notNull(),
    text: text("text"),
    status: summaryStatusEnum("status").notNull(),
    attempts: integer("attempts").notNull(),
    model: text("model"),
    promptVersion: integer("prompt_version"),
    runId: uuid("run_id").references(() => runs.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("profile_summaries_attempts_nonnegative", sql`${t.attempts} >= 0`),
    // An ok summary has its text and the prompt version the partial unique index below keys on; an empty one has no text.
    check("profile_summaries_ok_complete", sql`${t.status} <> 'ok' OR (${t.promptVersion} IS NOT NULL AND ${t.text} IS NOT NULL)`),
    check("profile_summaries_empty_no_text", sql`${t.status} <> 'empty' OR ${t.text} IS NULL`),
    // An empty summary may be generated again later; an ok one exists once per prompt version.
    uniqueIndex("profile_summaries_ok_unique")
      .on(t.geoObjectId, t.profileVersion, t.promptVersion)
      .where(sql`${t.status} = 'ok'`),
  ],
);

/** Working state: profiles of an evaluation run (a candidate rules version), never in the change feed. */
export const evaluationProfiles = pgTable(
  "evaluation_profiles",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    geoObjectId: uuid("geo_object_id")
      .notNull()
      .references(() => geoObjects.id),
    rulesVersion: text("rules_version").notNull(),
    factSchemaVersion: text("fact_schema_version").notNull(),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull(),
    provenance: jsonb("provenance").$type<Record<string, AttributeProvenance>>().notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ name: "evaluation_profiles_pk", columns: [t.runId, t.geoObjectId] })],
);

/** Working state: targeted source discovery requested for a thin place (cool-down per place). */
export const placeDiscoveryRequests = pgTable(
  "place_discovery_requests",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    geoObjectId: uuid("geo_object_id")
      .notNull()
      .references(() => geoObjects.id),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    runId: uuid("run_id").references(() => runs.id),
  },
  (t) => [index("place_discovery_requests_geo_object_idx").on(t.geoObjectId, t.requestedAt.desc())],
);

/** Working state: number of sitelinks (all wikis) per Wikidata item (importance signal, ruling M5-P1). */
export const wikidataSitelinks = pgTable("wikidata_sitelinks", {
  wikidataId: text("wikidata_id").primaryKey(),
  sitelinks: integer("sitelinks").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});
