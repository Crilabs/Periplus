import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import {
  COMPARISON_ATTRIBUTES,
  comparisonResults,
  configActivations,
  METRIC_KEYS,
  qualitySnapshots,
} from "@/lib/db/schema";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestRun } from "@/test/text";

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

  it("the in-list checks hold exactly COMPARISON_ATTRIBUTES and METRIC_KEYS", async () => {
    await withRollback(async (tx) => {
      const listed = async (name: string) => {
        const { rows } = await tx.execute<{ def: string }>(sql`
          select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`);
        return [...rows[0]!.def.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
      };
      expect(await listed("comparison_results_attribute_check")).toEqual([...COMPARISON_ATTRIBUTES].sort());
      expect(await listed("quality_snapshots_metric_check")).toEqual([...METRIC_KEYS].sort());
    });
  });

  it("metric and scope type are constrained, every metric key passes", async () => {
    await withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const metric = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`insert into quality_snapshots (id, run_id, scope_type, scope_id, metric)
          values (gen_random_uuid(), ${runId}, 'area', 'saronic', 'rating')`),
      );
      expect(metric).toMatch(/quality_snapshots_metric_check/);
      const scope = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`insert into quality_snapshots (id, run_id, scope_type, scope_id, metric)
          values (gen_random_uuid(), ${runId}, 'place', 'x', 'coverage')`),
      );
      expect(scope).toMatch(/quality_snapshots_scope_type/);
      for (const m of METRIC_KEYS) {
        await tx.insert(qualitySnapshots).values({ runId, scopeType: "area", scopeId: "saronic", metric: m, value: null });
      }
    });
  });

  it.each(["comparison_results", "quality_snapshots", "config_activations"])("%s rejects UPDATE and DELETE", async (table) => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const runId = await insertTestRun(tx);
      let id: string;
      const column = table === "config_activations" ? "activated_at" : "created_at";
      if (table === "comparison_results") {
        id = await insertResult(tx, placeId);
      } else if (table === "quality_snapshots") {
        const [row] = await tx
          .insert(qualitySnapshots)
          .values({ runId, scopeType: "area", scopeId: "saronic", metric: "coverage", value: 0.9 })
          .returning({ id: qualitySnapshots.id });
        id = row!.id;
      } else {
        const [row] = await tx
          .insert(configActivations)
          .values({ kind: "consolidation_rules", version: "v2", evaluationRunId: runId, comparison: {}, activatedBy: "admin@test" })
          .returning({ id: configActivations.id });
        id = row!.id;
      }
      const update = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = now() - interval '1 day' where id = ${id}`),
      );
      expect(update).toMatch(new RegExp(`${table} is append-only`));
      const del = await rejectionMessage(tx, (sp) => sp.execute(sql`delete from ${sql.identifier(table)} where id = ${id}`));
      expect(del).toMatch(new RegExp(`${table} is append-only`));
    });
  });

  it("one snapshot row per run, scope and metric", async () => {
    await withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const values = { runId, scopeType: "tile" as const, scopeId: "q025:808:500", metric: "places_per_tile" as const, value: 12 };
      await tx.insert(qualitySnapshots).values(values);
      // another scope or metric of the same run is fine
      await tx.insert(qualitySnapshots).values({ ...values, scopeId: "q025:808:501" });
      const duplicate = await rejectionMessage(tx, (sp) => sp.insert(qualitySnapshots).values(values));
      expect(duplicate).toMatch(/quality_snapshots_run_scope_metric_unique/);
    });
  });

  it("config_activations only take the two kinds", async () => {
    await withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const bad = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`insert into config_activations (id, kind, version, evaluation_run_id, comparison, activated_by)
          values (gen_random_uuid(), 'fact_schema', 'v3', ${runId}, '{}', 'admin@test')`),
      );
      expect(bad).toMatch(/config_activations_kind/);
    });
  });
});
