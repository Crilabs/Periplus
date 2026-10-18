import { gazetteerHandler } from "./handlers/gazetteer";
import { advanceHandler } from "./handlers/run-advance";
import { seedTileHandler } from "./handlers/seed";
import { pingHandler } from "./handlers/system-ping";
import { tilesEnsureHandler } from "./handlers/tiles";
import type { QueueName } from "./queues";
import type { JobData, JobHandler } from "./worker";

/** The handler the worker runs for each queue. */
export const HANDLERS: Record<QueueName, JobHandler<JobData>> = {
  "system.ping": pingHandler,
  "run.advance": advanceHandler,
  "tiles.ensure": tilesEnsureHandler,
  "gazetteer.build": gazetteerHandler,
  "seed.tile": seedTileHandler,
};
