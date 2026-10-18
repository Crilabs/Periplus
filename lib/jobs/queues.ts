import type { PgBoss } from "pg-boss";
import type { QueueConfig } from "@/lib/config";

export const QUEUES = ["system.ping"] as const;
export type QueueName = (typeof QUEUES)[number];

/** Receives every job that exhausted its attempts on any queue in QUEUES. */
export const DEAD_LETTER_QUEUE = "system.dead";

/**
 * Creates the dead-letter queue and every queue in QUEUES, and (re)applies the retry settings from
 * config so changed config takes effect on existing queues too.
 */
export async function ensureQueues(boss: PgBoss, config: Record<string, QueueConfig>): Promise<void> {
  if (!(await boss.getQueue(DEAD_LETTER_QUEUE))) await boss.createQueue(DEAD_LETTER_QUEUE);
  for (const name of QUEUES) {
    const queueConfig = config[name];
    if (!queueConfig) throw new Error(`config/queues.json has no entry for queue ${name}`);
    const options = {
      retryLimit: queueConfig.retryLimit,
      retryDelay: queueConfig.retryDelaySeconds,
      retryBackoff: queueConfig.retryBackoff,
      deadLetter: DEAD_LETTER_QUEUE,
    };
    if (await boss.getQueue(name)) await boss.updateQueue(name, options);
    else await boss.createQueue(name, options);
  }
}
