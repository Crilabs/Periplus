import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import {
  COMPARISON_ATTRIBUTES,
  comparisonResults,
} from "@/lib/db/schema";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";

/** drizzle wraps driver errors ("Failed query"); the Postgres message lives on `cause`. */
async function rejectionMessage(tx: Db, run: (tx: Db) => Promise<unknown>): Promise<string> {
  try {
    // savepoint, so the surrounding transaction survives the expected failure
    await tx.transaction(async (sp) => {
      await run(sp);
    });
  } catch (e) {
    const err = e as Error;
    return `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`;
  }
  throw new Error("expected promise to reject");
}

async function columnsOf(tx: Db, table: string): Promise<Record<string, string>> {
  const { rows } = await tx.execute<{ column_name: string; data_type: string }>(sql`
    select column_name, data_type from information_schema.columns
    where table_schema = current_schema() and table_name = ${table}`);
  return Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
}

const HASH = "0123456789abcdef";

async function insertResult(tx: Db, placeId: string, patch: Partial<typeof comparisonResults.$inferInsert> = {}) {
  const [row] = await tx
    .insert(comparisonResults)
    .values({ placeId, attribute: "existence", valueHash: HASH, result: "match", method: "manual", checkedBy: "admin@test", ...patch })
    .returning({ id: comparisonResults.id });
  return row!.id;
}

describe("quality schema", () => {
  it("comparison_results has no column that could hold a Navily value", async () => {
    await withRollback(async (tx) => {
      const cols = await columnsOf(tx, "comparison_results");
      expect(Object.keys(cols).sort()).toEqual([
        "attribute",
        "checked_at",
        "checked_by",
        "created_at",
        "evaluation_run_id",
        "id",
        "method",
        "place_id",
        "profile_version",
        "result",
        "review_task_id",
        "value_hash",
      ]);
      expect(Object.values(cols)).not.toContain("jsonb");
      expect(Object.values(cols)).not.toContain("numeric");
      expect(Object.values(cols)).not.toContain("double precision");
    });
  });

  it("value_hash and attribute are constrained", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const attribute = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`insert into comparison_results (id, place_id, attribute, value_hash, result, method, checked_by)
          values (gen_random_uuid(), ${placeId}, 'rating', ${HASH}, 'match', 'manual', 'admin@test')`),
      );
      expect(attribute).toMatch(/comparison_results_attribute_check/);
      const hash = await rejectionMessage(tx, (sp) => insertResult(sp, placeId, { valueHash: "abc" }));
      expect(hash).toMatch(/comparison_results_value_hash_format/);
      const checkedBy = await rejectionMessage(tx, (sp) => insertResult(sp, placeId, { checkedBy: "x".repeat(121) }));
      expect(checkedBy).toMatch(/comparison_results_checked_by_length/);
      // every listed attribute passes the check
      for (const a of COMPARISON_ATTRIBUTES) await insertResult(tx, placeId, { attribute: a });
    });
  });

  it("the in-list check holds exactly COMPARISON_ATTRIBUTES", async () => {
    await withRollback(async (tx) => {
      const listed = async (name: string) => {
        const { rows } = await tx.execute<{ def: string }>(sql`
          select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`);
        return [...rows[0]!.def.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
      };
      expect(await listed("comparison_results_attribute_check")).toEqual([...COMPARISON_ATTRIBUTES].sort());
    });
  });
});

describe("comparison_results protection", () => {
  it("is no longer append-only (design 7.2: only document_versions is)", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const id = await insertResult(tx, placeId);
      await tx.execute(sql`update comparison_results set checked_by = 'someone@test' where id = ${id}`);
      await tx.execute(sql`delete from comparison_results where id = ${id}`);
    });
  });
});
