import { drizzle, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

/** A database handle or a transaction on it, so domain functions can run inside `db.transaction`. */
export type Db = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export function createDb(url: string): { db: Db; close(): Promise<void> } {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
}

let singleton: { db: Db; close(): Promise<void> } | undefined;

/** Lazy process-wide pool on DATABASE_URL; nothing is read or connected at import time. */
export function getDb(): Db {
  singleton ??= createDb(getEnv().DATABASE_URL);
  return singleton.db;
}
