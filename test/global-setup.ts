import type { TestProject } from "vitest/node";
import { getConfig } from "../lib/config";
import { createBoss } from "../lib/jobs/boss";
import { ensureQueues } from "../lib/jobs/queues";
import { Client } from "pg";
import { MCP_READER_TEST_PASSWORD } from "./reader";
import { migrate } from "../scripts/migrate";

export default async function setup(project: TestProject): Promise<void> {
  // globalSetup runs in the main process, where `test.env` is not applied to process.env.
  const url = process.env.TEST_DATABASE_URL ?? project.config.env?.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to run tests: database name "${dbName}" must end with "_test"`);
  }
  await migrate(url);
  // The MCP reader role logs in on its own (migration 0082); its password is set by hand in production, here to a fixed one.
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`alter role periplus_mcp_reader password '${MCP_READER_TEST_PASSWORD}'`);
  await client.end();
  // The pg-boss schema and queues, as the worker installs them in production: tests that read or write pgboss.job
  // must not depend on another test file having started pg-boss first (a CI shard runs only some of the files).
  const boss = createBoss(url, { supervise: false, schedule: false });
  await boss.start();
  await ensureQueues(boss, getConfig().queues);
  await boss.stop({ graceful: false });
}
