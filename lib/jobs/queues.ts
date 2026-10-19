import type { PgBoss } from "pg-boss";
import type { QueueConfig } from "@/lib/config";

export const QUEUES = [
  "system.ping",
  "run.advance",
  "tiles.ensure",
  "gazetteer.build",
  "seed.tile",
  "datasets.import",
  "geometry.compute",
  "discovery.area",
  "discovery.tile",
  "discovery.propose",
  "fetch.source",
  "fetch.url",
  "embed.chunks",
  "sources.wikivoyage",
  "compare.converters",
  "ai.batch.poll",
  "classify.document_version",
  "mentions.batch",
  "mentions.disambiguate",
  "mentions.geocode",
  "extraction.mention",
] as const;
export type QueueName = (typeof QUEUES)[number];

/** Moves a run to its next stage (plans and enqueues it), decoupled from the job that finished the stage. */
export const RUN_ADVANCE_QUEUE = "run.advance" satisfies QueueName;

/** Polls one provider message batch and hands its results on; not part of a run's stage counts (ruling M4-P2). */
export const BATCH_POLL_QUEUE = "ai.batch.poll" satisfies QueueName;

/** Receives every job that exhausted its attempts on any queue in QUEUES. */
export const DEAD_LETTER_QUEUE = "system.dead";

/**
 * Retry settings for the dead-letter queue: its handler only writes a review task and the run outcome,
 * so failures are transient (DB) and get more, slower attempts. A job that still fails stays `failed`
 * in system.dead and shows up in the overview and jobs views. `config["system.dead"]` overrides (tests).
 */
export const DEAD_LETTER_DEFAULTS: QueueConfig = { concurrency: 1, retryLimit: 5, retryDelaySeconds: 60, retryBackoff: true };

export function deadLetterQueueOptions(config: Record<string, QueueConfig>) {
  const c = config[DEAD_LETTER_QUEUE] ?? DEAD_LETTER_DEFAULTS;
  return { retryLimit: c.retryLimit, retryDelay: c.retryDelaySeconds, retryBackoff: c.retryBackoff };
}

/**
 * Creates the dead-letter queue and every queue in QUEUES, and (re)applies the retry and expiry settings
 * so changed settings take effect on existing queues too.
 */
export async function ensureQueues(boss: PgBoss, config: Record<string, QueueConfig>): Promise<void> {
  const deadLetterOptions = deadLetterQueueOptions(config);
  if (await boss.getQueue(DEAD_LETTER_QUEUE)) await boss.updateQueue(DEAD_LETTER_QUEUE, deadLetterOptions);
  else await boss.createQueue(DEAD_LETTER_QUEUE, deadLetterOptions);
  for (const name of QUEUES) {
    const queueConfig = config[name];
    if (!queueConfig) throw new Error(`config/queues.json has no entry for queue ${name}`);
    const options = {
      retryLimit: queueConfig.retryLimit,
      retryDelay: queueConfig.retryDelaySeconds,
      retryBackoff: queueConfig.retryBackoff,
      deadLetter: DEAD_LETTER_QUEUE,
      // Long jobs (a crawled PDF transcribed page by page) must not expire mid-way and run twice.
      ...(queueConfig.expireInSeconds !== undefined ? { expireInSeconds: queueConfig.expireInSeconds } : {}),
    };
    if (await boss.getQueue(name)) await boss.updateQueue(name, options);
    else await boss.createQueue(name, options);
  }
}
