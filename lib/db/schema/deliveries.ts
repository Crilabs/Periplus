import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { newId } from "@/lib/domain/ids";
import { geoObjects } from "./geo";
import { runs } from "./ops";

/*
 * Delivery packages (spec 08). Both tables are append-only (forbid_mutation trigger,
 * drizzle/0039_delivery_triggers.sql): a build writes one `deliveries` row and the contract versions it introduced.
 */

export const deliveryStatusEnum = pgEnum("delivery_status", ["valid", "rejected", "unchanged"]);
export const deliveredObjectTypeEnum = pgEnum("delivered_object_type", ["spot", "highlight", "region"]);

export type DeliveryStatus = (typeof deliveryStatusEnum.enumValues)[number];
export type DeliveredObjectType = (typeof deliveredObjectTypeEnum.enumValues)[number];

/** Postgres `xid8` (transaction id); the driver returns it as a decimal string. */
const xid8 = customType<{ data: string; driverData: string }>({ dataType: () => "xid8" });

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * One package build per row. `data_version` only for a `valid` package (rising by 1 per area); a `rejected` package is
 * stored for diagnosis under its own prefix, an `unchanged` build stores nothing.
 */
export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    areaId: uuid("area_id")
      .notNull()
      .references(() => geoObjects.id),
    dataVersion: integer("data_version"),
    schemaVersion: text("schema_version").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    status: deliveryStatusEnum("status").notNull(),
    /** S3 prefix of the files; null for `unchanged`. */
    storagePrefix: text("storage_prefix"),
    /** `{ "<file>": { sha256, bytes } }`. */
    fileHashes: jsonb("file_hashes").$type<Record<string, { sha256: string; bytes: number }>>().notNull().default({}),
    objectCounts: jsonb("object_counts").$type<Record<string, number>>().notNull(),
    validationReport: jsonb("validation_report").notNull(),
    previousDeliveryId: uuid("previous_delivery_id").references((): AnyPgColumn => deliveries.id),
    /**
     * Change-feed window end (ruling M6-P1): `pg_snapshot_xmin(pg_current_snapshot())` right after the build took its
     * area lock. The package covers the change events with `xact_id` below it and at or above its predecessor's.
     */
    changeXmin: xid8("change_xmin").notNull(),
    runId: uuid("run_id").references(() => runs.id),
    triggeredBy: text("triggered_by"),
    createdAt: createdAt(),
  },
  (t) => [
    check("deliveries_data_version_iff_valid", sql`(${t.status} = 'valid') = (${t.dataVersion} IS NOT NULL)`),
    check("deliveries_data_version_positive", sql`${t.dataVersion} >= 1`),
    check("deliveries_storage_prefix_iff_stored", sql`(${t.status} = 'unchanged') = (${t.storagePrefix} IS NULL)`),
    uniqueIndex("deliveries_area_data_version_unique")
      .on(t.areaId, t.dataVersion)
      .where(sql`${t.dataVersion} IS NOT NULL`),
    index("deliveries_area_created_idx").on(t.areaId, t.createdAt.desc()),
  ],
);

/**
 * Contract versions: one row per version of a delivered object, written by the delivery that introduced it. Spot and
 * highlight versions count per public id (a tile relabel may move one to another area), region versions per area
 * package (ruling M6-P13). A removed object gets a version with `removed` and the hash `removed`.
 */
export const deliveredObjects = pgTable(
  "delivered_objects",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    areaId: uuid("area_id")
      .notNull()
      .references(() => geoObjects.id),
    objectType: deliveredObjectTypeEnum("object_type").notNull(),
    publicId: text("public_id").notNull(),
    geoObjectId: uuid("geo_object_id").references(() => geoObjects.id),
    profileVersion: integer("profile_version").notNull(),
    /** Hash of the serialized contract object without its version fields; `removed` for a removed object. */
    contentHash: text("content_hash").notNull(),
    validFrom: date("valid_from").notNull(),
    removed: boolean("removed").notNull().default(false),
    firstDeliveryId: uuid("first_delivery_id")
      .notNull()
      .references(() => deliveries.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("delivered_objects_profile_version_positive", sql`${t.profileVersion} >= 1`),
    check("delivered_objects_removed_hash", sql`${t.removed} = (${t.contentHash} = 'removed')`),
    check(
      "delivered_objects_public_id_prefix",
      sql`${t.publicId} ~ ('^' || CASE ${t.objectType} WHEN 'spot' THEN 'sp' WHEN 'highlight' THEN 'hl' ELSE 'rg' END || '_')`,
    ),
    uniqueIndex("delivered_objects_public_version_unique")
      .on(t.publicId, t.profileVersion)
      .where(sql`${t.objectType} IN ('spot', 'highlight')`),
    uniqueIndex("delivered_objects_area_region_version_unique")
      .on(t.areaId, t.publicId, t.profileVersion)
      .where(sql`${t.objectType} = 'region'`),
    index("delivered_objects_public_valid_from_idx").on(t.publicId, t.validFrom.desc()),
  ],
);
