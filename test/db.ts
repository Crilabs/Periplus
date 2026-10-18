import { afterAll } from "vitest";
import { createDb, type Db } from "@/lib/db/client";

let handle: ReturnType<typeof createDb> | undefined;

/** One pool per test worker on TEST_DATABASE_URL, closed after the worker's tests. */
export function testDb(): Db {
  if (!handle) {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is not set");
    handle = createDb(url);
    afterAll(async () => {
      await handle?.close();
      handle = undefined;
    });
  }
  return handle.db;
}

class Rollback extends Error {}

/**
 * Runs `fn` in a transaction that is always rolled back; returns fn's result or rethrows its error.
 *
 * Convention for geo tests: stable tables (geo_objects, geo_names, places, tiles, restricted_areas)
 * can never be deleted (forbid_delete), so committed rows pile up in the shared _test database.
 * Write them through `withRollback`. A test that must commit geo rows uses coordinates outside the
 * pilot box 23.0-23.75 E x 37.0-38.0 N so it cannot pollute pilot-area queries.
 * After a failed statement the transaction is aborted; wrap expected failures in `tx.transaction`
 * (savepoint) if the test continues afterwards.
 *
 * Pass `isolationLevel: "repeatable read"` for before/after comparisons of database-wide aggregates
 * (counts per kind, per queue): the transaction then sees one snapshot plus its own writes, never rows
 * other test files commit meanwhile.
 */
export async function withRollback<T>(
  fn: (tx: Db) => Promise<T>,
  options: { isolationLevel?: "read committed" | "repeatable read" } = {},
): Promise<T> {
  let result: T;
  try {
    await testDb().transaction(async (tx) => {
      result = await fn(tx);
      throw new Rollback();
    }, options);
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return result!;
}
