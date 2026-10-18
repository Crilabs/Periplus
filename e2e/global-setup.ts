import { execFileSync } from "node:child_process";
import { createDb } from "../lib/db/client";
import { createUser } from "../lib/domain/users";

/** Idempotent: creates the e2e admin in the TEST database unless it already exists. */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://periplus:periplus@localhost:5434/periplus_test";
  const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!dbName.endsWith("_test")) throw new Error(`Refusing to run e2e: database "${dbName}" must end with "_test"`);

  // The e2e run may be the first thing to touch the test database, so make sure it is migrated.
  execFileSync("npx", ["tsx", "scripts/migrate.ts"], { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });
  const { db, close } = createDb(url);
  try {
    await createUser(db, process.env.E2E_EMAIL!, process.env.E2E_PASSWORD!);
  } catch (error) {
    if (!/duplicate key|unique/i.test(String(error) + String((error as { cause?: unknown }).cause))) throw error;
  } finally {
    await close();
  }
}
