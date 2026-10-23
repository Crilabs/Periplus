import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { places, type PoiCategory } from "./geo";
import { runs } from "./ops";
import type { Tone } from "./research-extract";

/*
 * Current state per confirmed berth (plan N4a): the bundled, cited picture of one berth. A derived table that is
 * rewritten per place, never appended; a place that leaves `confirmed` keeps its row, the delivery filters on status.
 */

export type BerthStateOrigin = "computed" | "text" | "rule";
/** A core value of the state with its confidence, where it comes from and the facts that carry it. */
export type BerthStateValue = { value: unknown; confidence: number; origin: BerthStateOrigin; observedAt: string | null; factIds: string[] };
/** A bundled fact; the representative is always an existing `berth_facts` row (no new text). */
export type BerthStateFact = {
  factId: string;
  subject: "berth" | "landside";
  subjectName: string | null;
  subjectCategory: string | null;
  statement: string;
  observedAt: string;
  tone: Tone | null;
  safety: boolean;
  mentions: number;
};
export type BerthLandingKind = "harbour" | "pier" | "slipway" | "beach" | "shore" | "text";
export type BerthStateLanding = { kind: BerthLandingKind; lon: number | null; lat: number | null; geoObjectId: string | null; description: string | null };
export type BerthStateNearby = { geoObjectId: string; category: PoiCategory; distanceM: number; access: "foot" | "transport" };

export const berthStates = pgTable(
  "berth_states",
  {
    placeId: uuid("place_id")
      .primaryKey()
      .references(() => places.id),
    core: jsonb("core").$type<Record<string, BerthStateValue>>().notNull(),
    gaps: text("gaps").array().notNull(),
    facts: jsonb("facts").$type<BerthStateFact[]>().notNull(),
    landing: jsonb("landing").$type<BerthStateLanding[]>().notNull(),
    nearby: jsonb("nearby").$type<BerthStateNearby[]>().notNull(),
    runId: uuid("run_id").references(() => runs.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("berth_states_run_id_idx").on(t.runId)],
);
