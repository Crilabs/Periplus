import type { TestProject } from "vitest/node";
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
}
