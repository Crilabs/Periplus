import { sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { Db } from "@/lib/db/client";

/*
 * The snapshot a package is built from (ruling M6-D-R3). The build reads berth states, tile dates and popularity in
 * one REPEATABLE READ read-only transaction; the snapshot of that transaction is stored in `deliveries.change_snapshot`
 * (the stored column and its name stay; contract 4.0 has no change feed that reads it). So the package holds exactly what
 * that snapshot saw: a transaction the build saw lands in this package, one still in flight lands in the next one.
 */

/** `pg_snapshot` text (`xmin:xmax:xip,…`) and its `xmin` (kept as `deliveries.change_xmin`). */
export type BuildSnapshot = { snapshot: string; xmin: string };

/**
 * Runs `read` in a new REPEATABLE READ read-only transaction whose first statement captures its snapshot, and returns
 * the snapshot with read's result. Pass the root pool handle, not a transaction: a nested `db.transaction` would be a
 * savepoint in the caller's isolation level and its snapshot. Take the subdivision lock before calling (in the writing
 * transaction): the snapshot is taken here, after the lock, so it sees the previous build's commit.
 */
export async function openBuildSnapshot<T>(
  db: Db,
  read: (tx: Db, snapshot: BuildSnapshot) => Promise<T>,
): Promise<{ snapshot: BuildSnapshot; result: T }> {
  if (db instanceof PgTransaction) throw new Error("openBuildSnapshot needs the pool handle, not a transaction");
  return db.transaction(
    async (tx) => {
      const snapshot = await currentSnapshot(tx);
      return { snapshot, result: await read(tx, snapshot) };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** The current snapshot of `db`'s connection (as the first statement of a REPEATABLE READ transaction, its snapshot). */
export async function currentSnapshot(db: Db): Promise<BuildSnapshot> {
  const { rows } = await db.execute<{ snapshot: string; xmin: string }>(
    sql`select pg_current_snapshot()::text as snapshot, pg_snapshot_xmin(pg_current_snapshot())::text as xmin`,
  );
  return rows[0]!;
}
