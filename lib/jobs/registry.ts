import type { StageDefinition } from "@/lib/pipeline/runs";
import { pingHandler, pingStage } from "./handlers/system-ping";
import type { QueueName } from "./queues";
import type { JobData, JobHandler } from "./worker";

/** Every stage a run may name, by stage name. */
export const STAGES: Record<string, StageDefinition> = {
  [pingStage.name]: pingStage,
};

/** The handler the worker runs for each queue. */
export const HANDLERS: Record<QueueName, JobHandler<JobData>> = {
  "system.ping": pingHandler,
};
