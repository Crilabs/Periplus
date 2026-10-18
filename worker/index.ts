import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { workerHeartbeats } from "@/lib/db/schema";
import { getArchive } from "@/lib/adapters/s3";
import { getEnv } from "@/lib/env";
import { createBoss } from "@/lib/jobs/boss";
import { DEAD_LETTER_QUEUE, ensureQueues, QUEUES } from "@/lib/jobs/queues";
import { HANDLERS } from "@/lib/jobs/registry";
import { startWorkers } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";

const HEARTBEAT_MS = 30_000;
const log = createLogger("worker-main");

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb();
  await getArchive().ensureBucket();
  log.info("archive bucket ready");
  const boss = createBoss(getEnv().DATABASE_URL);
  await boss.start();
  await ensureQueues(boss, config.queues);
  const workers = await startWorkers(boss, db, HANDLERS, config.queues);

  const host = hostname();
  const workerId = `${host}:${process.pid}`;
  const startedAt = new Date();
  async function beat(): Promise<void> {
    await db
      .insert(workerHeartbeats)
      .values({ workerId, host, startedAt, beatAt: sql`now()` })
      .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { beatAt: sql`now()` } });
  }
  await beat();
  const heartbeat = setInterval(() => {
    beat().catch((err: unknown) => log.error({ err }, "heartbeat failed"));
  }, HEARTBEAT_MS);

  log.info({ workerId, queues: [...QUEUES, DEAD_LETTER_QUEUE] }, "worker started");

  let stopping = false;
  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "worker stopping");
    clearInterval(heartbeat);
    try {
      await workers.stop();
      await boss.stop({ graceful: true });
      log.info("worker stopped");
      process.exit(0);
    } catch (err) {
      log.error({ err }, "worker stop failed");
      process.exit(1);
    }
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  log.fatal({ err }, "worker failed to start");
  process.exit(1);
});
