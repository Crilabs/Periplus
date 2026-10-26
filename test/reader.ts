import { createDb, type Db } from "@/lib/db/client";
import { readerDatabaseUrl } from "@/lib/db/reader";

/** The password the test setup gives the MCP reader role (test cluster only). */
export const MCP_READER_TEST_PASSWORD = "mcp-reader-test";

let reader: { db: Db; close(): Promise<void> } | undefined;

/** A connection as the MCP reader role on the test database. */
export function testReaderDb(): Db {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  reader ??= createDb(readerDatabaseUrl(url, MCP_READER_TEST_PASSWORD));
  return reader.db;
}
