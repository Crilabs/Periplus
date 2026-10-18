import type { EventEmitter } from "node:events";
import { sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { testDb } from "@/test/db";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("has all extensions after migration", async () => {
  const rows = await testDb().execute(sql`select extname from pg_extension`);
  expect(rows.rows.map((r) => r.extname)).toEqual(
    expect.arrayContaining(["postgis", "postgis_raster", "vector", "pg_trgm", "unaccent"]),
  );
});

it("importing the client module without DATABASE_URL does not throw", async () => {
  vi.stubEnv("DATABASE_URL", "");
  await expect(import("../client")).resolves.toHaveProperty("getDb");
});

it("pool error is logged, not thrown", async () => {
  const { createDb } = await import("../client");
  const handle = createDb(process.env.TEST_DATABASE_URL!);
  try {
    const pool = (handle.db as unknown as { $client: EventEmitter }).$client;
    expect(() => pool.emit("error", new Error("idle client failed"))).not.toThrow();
  } finally {
    await handle.close();
  }
});
