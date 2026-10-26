import { hostname } from "node:os";
import { eq, sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { workerHeartbeats } from "@/lib/db/schema";
import { closeRenderer } from "@/lib/adapters/fetch/browser";
import { getArchive } from "@/lib/adapters/s3";
import { createAnthropicClient } from "@/lib/ai/anthropic";
import { getTransport } from "@/lib/adapters/http";
import { createOpenAiImageModel } from "@/lib/adapters/openai-image";
import { getEnv } from "@/lib/env";
import { createBoss } from "@/lib/jobs/boss";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { setModelClientFactory } from "@/lib/jobs/handlers/ai-batch";
import { setImageModelFactory } from "@/lib/pipeline/images/model";
import { DEAD_LETTER_QUEUE, ensureQueues, QUEUES } from "@/lib/jobs/queues";
import { clearReadyMarker, touchReadyMarker } from "@/lib/jobs/ready-marker";
import { HANDLERS } from "@/lib/jobs/registry";
import { startWorkers } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";

const HEARTBEAT_MS = 30_000;
const log = createLogger("worker-main");

async function main(): Promise<void> {
  // Not ready until every start check below has passed (a restarted container keeps the marker of its last start).
  clearReadyMarker();
  const config = getConfig();
  const db = getDb();
  await getArchive().ensureBucket();
  log.info("archive bucket ready");
  const boss = createBoss(getEnv().DATABASE_URL);
  await boss.start();
  await ensureQueues(boss, config.queues);
  // Batch jobs submit and collect message batches through this client (the key is read on first use).
  setModelClientFactory((jobDb) => createAnthropicClient(jobDb, config));
  // Image jobs paint over their renders through this model (the key is read on first use).
  const imageModel = createOpenAiImageModel(getTransport(), config);
  setImageModelFactory(() => imageModel);
  const workers = await startWorkers(boss, db, HANDLERS, config.queues, { batchHandlers: BATCH_HANDLERS });

  const host = hostname();
  const workerId = `${host}:${process.pid}`;
  const startedAt = new Date();
  async function beat(): Promise<void> {
    await db
      .insert(workerHeartbeats)
      .values({ workerId, host, startedAt, beatAt: sql`now()` })
      .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { beatAt: sql`now()` } });
    // Fresh only while the heartbeat reaches the database (compose healthcheck, deploy check).
    touchReadyMarker();
  }
  await beat();
  let beating: Promise<void> = Promise.resolve();
  const heartbeat = setInterval(() => {
    beating = beat().catch((err: unknown) => log.error({ err }, "heartbeat failed"));
  }, HEARTBEAT_MS);

  log.info({ workerId, queues: [...QUEUES, DEAD_LETTER_QUEUE] }, "worker started");

  let stopping = false;
  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "worker stopping");
    clearInterval(heartbeat);
    clearReadyMarker();
    try {
      await workers.stop();
      await boss.stop({ graceful: true });
      // After the last job: a page render may still have been running until then. A browser that will not close
      // must not keep the heartbeat row alive.
      try {
        await closeRenderer();
      } catch (err) {
        log.error({ err }, "closing the renderer failed");
      }
      // Remove our heartbeat so the overview does not list this worker as alive; wait for an
      // in-flight beat first so it cannot re-insert the row afterwards.
      await beating;
      await db.delete(workerHeartbeats).where(eq(workerHeartbeats.workerId, workerId));
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
