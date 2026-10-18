import { advanceHandler } from "./handlers/run-advance";
import { pingHandler } from "./handlers/system-ping";
import type { QueueName } from "./queues";
import type { JobData, JobHandler } from "./worker";

/** The handler the worker runs for each queue. */
export const HANDLERS: Record<QueueName, JobHandler<JobData>> = {
  "system.ping": pingHandler,
  "run.advance": advanceHandler,
};
