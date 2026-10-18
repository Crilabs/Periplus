import { sql } from "drizzle-orm";
import { getArchive } from "@/lib/adapters/s3";
import { getDb } from "@/lib/db/client";
import { createLogger } from "@/lib/logger";

const CHECK_TIMEOUT_MS = 3000;

async function withTimeout(check: () => Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check().catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** True when the database answers `select 1` and the archive answers a ping, each within 3 s. */
export async function isReady(): Promise<boolean> {
  const [database, archive] = await Promise.all([
    withTimeout(async () => {
      await getDb().execute(sql`select 1`);
      return true;
    }),
    withTimeout(() => getArchive().ping()),
  ]);
  if (!database || !archive) createLogger("health").warn({ database, archive }, "readiness check failed");
  return database && archive;
}
