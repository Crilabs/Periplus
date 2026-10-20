import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";

/** Indexes for the joins the admin pages and consolidation run on every load (gesamt-review DAT-7). */
describe("lookup indexes", () => {
  it("external_calls by run and by tile, review_decisions by task", () =>
    withRollback(async (tx) => {
      const { rows } = await tx.execute<{ indexname: string; indexdef: string }>(sql`
        select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename in ('external_calls', 'review_decisions')
      `);
      const defs = rows.map((r) => r.indexdef.replace(/^.* USING /, ""));
      expect(defs).toContain("btree (run_id)");
      expect(defs).toContain("btree (tile_id, at)");
      expect(defs).toContain("btree (task_id)");
    }));
});
