import { PgBoss } from "pg-boss";
import { getConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { ensureQueues } from "./queues";

const log = createLogger("boss");

export function createBoss(url: string): PgBoss {
  const boss = new PgBoss({ connectionString: url, schema: "pgboss" });
  boss.on("error", (err) => log.error({ err }, "pg-boss error"));
  return boss;
}

let started: Promise<PgBoss> | undefined;

/** Lazily started process-wide instance for enqueueing (web); nothing is read or connected at import time. */
export function getBoss(): Promise<PgBoss> {
  started ??= (async () => {
    const boss = createBoss(getEnv().DATABASE_URL);
    await boss.start();
    await ensureQueues(boss, getConfig().queues);
    return boss;
  })().catch((err: unknown) => {
    started = undefined;
    throw err;
  });
  return started;
}
