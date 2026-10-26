import { getEnv } from "@/lib/env";
import { createDb, type Db } from "./client";

/** The database role of the MCP tool `sql` (migrations 0081, 0082): own login, SELECT only, read only, timeout. */
export const MCP_READER_ROLE = "periplus_mcp_reader";

/** `databaseUrl` with the reader's credentials: same host, port and database, user `periplus_mcp_reader`. */
export function readerDatabaseUrl(databaseUrl: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = MCP_READER_ROLE;
  url.password = password;
  return url.toString();
}

let singleton: { db: Db; close(): Promise<void> } | null | undefined;

/** Lazy pool as the reader role; null while `MCP_READER_PASSWORD` is unset (the tool `sql` is off then). */
export function getReaderDb(): Db | null {
  if (singleton === undefined) {
    const env = getEnv();
    singleton = env.MCP_READER_PASSWORD ? createDb(readerDatabaseUrl(env.DATABASE_URL, env.MCP_READER_PASSWORD)) : null;
  }
  return singleton?.db ?? null;
}
