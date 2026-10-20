import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

/** Navily markers of the synthetic fixture (`test/fixtures/navily/sample.json`): names, ids and urls (the rating is never read). */
export const NAVILY_MARKERS = /NAVILY-ONLY-NAME|NAVILY-PORT|987654321|123456789|555000111|navily\.com/;

/**
 * Every row of `comparison_results`, `review_tasks` and `quality_snapshots` the current transaction wrote, as JSON
 * (Grundprinzip 9 guards).
 * A row written in this transaction has `created_at = now()` (the transaction's start, also inside savepoints), so the
 * guard sees the writes of every place and subject, not only those of the place under test.
 */
export async function rowsWrittenInTransaction(tx: Db): Promise<string[]> {
  const { rows } = await tx.execute<{ row: string }>(sql`
    select row_to_json(c)::text as row from comparison_results c where c.created_at = now()
    union all
    select row_to_json(r)::text as row from review_tasks r where r.created_at = now()
    union all
    select row_to_json(q)::text as row from quality_snapshots q where q.created_at = now()`);
  return rows.map((r) => r.row);
}
