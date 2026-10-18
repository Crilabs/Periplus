import { PgBoss, type ConstructorOptions } from "pg-boss";
import { getConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { ensureQueues } from "./queues";

type BossOptions = Pick<ConstructorOptions, "supervise" | "schedule">;

/** Full instance by default (maintenance and cron on), as the worker process needs. */
export function createBoss(url: string, options: BossOptions = {}): PgBoss {
  const boss = new PgBoss({ connectionString: url, schema: "pgboss", ...options });
  boss.on("error", (err) => createLogger("boss").error({ err }, "pg-boss error"));
  return boss;
}

let started: Promise<PgBoss> | undefined;

/**
 * Lazily started process-wide instance for enqueueing (web); nothing is read or connected at import time.
 * Supervision (maintenance, monitoring) and cron scheduling stay with the worker, so the web process
 * runs no pg-boss background loops.
 */
export function getBoss(): Promise<PgBoss> {
  started ??= (async () => {
    const boss = createBoss(getEnv().DATABASE_URL, { supervise: false, schedule: false });
    await boss.start();
    await ensureQueues(boss, getConfig().queues);
    return boss;
  })().catch((err: unknown) => {
    started = undefined;
    throw err;
  });
  return started;
}
