import { datasetsImportHandler } from "./handlers/datasets";
import { discoveryAreaHandler, discoveryProposeHandler, discoveryTileHandler } from "./handlers/discovery";
import { gazetteerHandler } from "./handlers/gazetteer";
import { geometryPlaceHandler } from "./handlers/geometry";
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
  "datasets.import": datasetsImportHandler,
  "geometry.compute": geometryPlaceHandler,
  "discovery.area": discoveryAreaHandler,
  "discovery.tile": discoveryTileHandler,
  "discovery.propose": discoveryProposeHandler,
};
