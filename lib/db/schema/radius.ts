import { sql } from "drizzle-orm";
import { check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { CoverageEntry } from "@/contract/v3_0";
import { newId } from "@/lib/domain/ids";
import { apiClients } from "./auth";

/*
 * Radius packages (spec 18): built on request from the current valid subdivision packages and kept under a key over
 * marina, days, radius, contract version and the subdivision versions (`radiusPackageKey`). Both tables are
 * append-only (forbid_mutation trigger, drizzle/0069_radius_packages.sql): one row per built package, one row per
 * request (package, file or changes), for the request counts of the admin page.
 */

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const radiusPackages = pgTable(
  "radius_packages",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    key: text("key").notNull().unique(),
    homeMarinaPublicId: text("home_marina_public_id").notNull(),
    days: integer("days").notNull(),
    radiusNm: doublePrecision("radius_nm").notNull(),
    /** The manifest's `coverage`: every touched subdivision, delivered with its data version or missing. */
    coverage: jsonb("coverage").$type<CoverageEntry[]>().notNull(),
    schemaVersion: text("schema_version").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    /** `deliveries/radius/<marina>/<days>/<key>/`. */
    storagePrefix: text("storage_prefix").notNull(),
    /** `{ "<file>": { sha256, bytes } }`. */
    fileHashes: jsonb("file_hashes").$type<Record<string, { sha256: string; bytes: number }>>().notNull(),
    objectCounts: jsonb("object_counts").$type<Record<string, number>>().notNull(),
    /** Shared objects whose versions differ between subdivision packages (`composeRadiusPackage`). */
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("radius_packages_marina_days_idx").on(t.homeMarinaPublicId, t.days, t.createdAt.desc())],
);

export const radiusPackageRequests = pgTable(
  "radius_package_requests",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    radiusPackageId: uuid("radius_package_id")
      .notNull()
      .references(() => radiusPackages.id),
    apiClientId: uuid("api_client_id").references(() => apiClients.id),
    kind: text("kind").$type<"package" | "file" | "changes">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("radius_package_requests_kind", sql`${t.kind} IN ('package', 'file', 'changes')`),
    index("radius_package_requests_package_idx").on(t.radiusPackageId),
  ],
);
