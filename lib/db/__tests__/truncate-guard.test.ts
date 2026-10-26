import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";

/*
 * The append-only archive table refuses TRUNCATE as it refuses UPDATE/DELETE (gesamt-review DAT-6). The check reads
 * the catalog and truncates a temporary table only: a TRUNCATE of a shared table would take an exclusive lock that
 * blocks every parallel test file.
 */

/** Tables guarded per row by forbid_mutation, and the subset also guarded against TRUNCATE. */
async function guardedTables(db: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const { rows } = await db.execute<{ table: string; truncate: boolean }>(sql`
    select c.relname as table,
           bool_or((t.tgtype & 32) <> 0) as truncate
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_proc p on p.oid = t.tgfoid
    where p.proname in ('forbid_mutation', 'forbid_delete') and not t.tgisinternal
    group by c.relname
    order by c.relname
  `);
  return rows;
}

describe("TRUNCATE guard", () => {
  it("document_versions, the archive, is the only guarded table and has a BEFORE TRUNCATE trigger (design 7.2)", () =>
    withRollback(async (tx) => {
      const tables = await guardedTables(tx);
      expect(tables).toEqual([{ table: "document_versions", truncate: true }]);
    }));

  it("the guard function raises on TRUNCATE", () =>
    withRollback(async (tx) => {
      await tx.execute(sql`create temporary table truncate_guard_probe (id int) on commit drop`);
      await tx.execute(sql.raw(`create trigger probe_truncate before truncate on truncate_guard_probe for each statement execute function forbid_mutation('')`));
      await expect(tx.transaction((sp) => sp.execute(sql`truncate truncate_guard_probe`))).rejects.toThrow();
    }));
});
