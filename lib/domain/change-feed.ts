import { sql, type SQL } from "drizzle-orm";
import { changeEvents } from "@/lib/db/schema";

/**
 * Outbox guard for the change feed (ruling M5-A-R2). `change_events.seq` is assigned at insert, not at commit, so a
 * transaction with a lower `seq` may commit after a reader has already passed it. Only rows written by transactions
 * that are no longer in flight are safe to hand out in `seq` order: the M6 `/changes` reader must always add this
 * filter, i.e. `xact_id < pg_snapshot_xmin(pg_current_snapshot())`.
 */
export function visibleChangeEventsFilter(): SQL {
  return sql`${changeEvents.xactId} < pg_snapshot_xmin(pg_current_snapshot())`;
}
