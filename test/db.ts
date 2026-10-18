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
