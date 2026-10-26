import { sql } from "drizzle-orm";
import { check, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { newId } from "@/lib/domain/ids";
import { places } from "./geo";
import { runs } from "./ops";
import { reviewTasks } from "./review";

/*
 * Navily comparison results (spec 10). The quality snapshots and config activations of the old measurement run went
 * with the old approach (drizzle/0080_drop_old_pipeline.sql). Grundprinzip 9: `comparison_results` stores the outcome
 * of a comparison and the hash of the own value only; it has no column a Navily value would fit in.
 */

/** The compared attributes (spec 10 „Existenz, Position, Schutz je Sektor, Tiefe, Grund, Bojen, Versorgung, Taverne“). */
export const COMPARISON_ATTRIBUTES = [
  "existence",
  "position",
  "shelter.N",
  "shelter.NE",
  "shelter.E",
  "shelter.SE",
  "shelter.S",
  "shelter.SW",
  "shelter.W",
  "shelter.NW",
  "depth",
  "seabed",
  "mooring.buoys",
  "services.water",
  "highlight.supply",
  "highlight.food",
] as const;
export type ComparisonAttribute = (typeof COMPARISON_ATTRIBUTES)[number];

export const comparisonResultEnum = pgEnum("comparison_result", [
  "match",
  "deviation",
  "not_at_navily",
  "deviation_confirmed_own",
  "deviation_confirmed_navily",
  "unclear",
]);
export const comparisonMethodEnum = pgEnum("comparison_method", ["manual", "proposal_confirmed", "proposal_auto", "review"]);

export type ComparisonResultValue = (typeof comparisonResultEnum.enumValues)[number];
export type ComparisonMethod = (typeof comparisonMethodEnum.enumValues)[number];

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * One comparison outcome of an attribute of a place. `value_hash` identifies the own (normalised) value that was
 * compared, so an outcome stays valid as long as the value does (`comparisonValues`); the newest row per
 * `(place_id, attribute, value_hash)` is the current one.
 */
export const comparisonResults = pgTable(
  "comparison_results",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id),
    attribute: text("attribute").$type<ComparisonAttribute>().notNull(),
    /** The profile version compared; null for an evaluation profile. */
    profileVersion: integer("profile_version"),
    evaluationRunId: uuid("evaluation_run_id").references(() => runs.id),
    valueHash: text("value_hash").notNull(),
    result: comparisonResultEnum("result").notNull(),
    method: comparisonMethodEnum("method").notNull(),
    checkedBy: text("checked_by").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    reviewTaskId: uuid("review_task_id").references(() => reviewTasks.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("comparison_results_value_hash_format", sql`${t.valueHash} ~ '^[0-9a-f]{16}$'`),
    check("comparison_results_checked_by_length", sql`char_length(${t.checkedBy}) <= 120`),
    index("comparison_results_place_attribute_hash_idx").on(t.placeId, t.attribute, t.valueHash, t.checkedAt.desc()),
  ],
);
