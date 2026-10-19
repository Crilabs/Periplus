import { aiBatchPollHandler } from "./handlers/ai-batch";
import { compareConvertersHandler } from "./handlers/compare";
import { datasetsImportHandler } from "./handlers/datasets";
import { discoveryAreaHandler, discoveryProposeHandler, discoveryTileHandler } from "./handlers/discovery";
import { embedChunksHandler } from "./handlers/embed";
import { fetchSourceHandler, fetchUrlHandler } from "./handlers/fetch";
import { gazetteerHandler } from "./handlers/gazetteer";
import { geometryPlaceHandler } from "./handlers/geometry";
import { advanceHandler } from "./handlers/run-advance";
import { seedTileHandler } from "./handlers/seed";
import { pingHandler } from "./handlers/system-ping";
import { classifyDocumentVersionHandler, disambiguateMentionsHandler, mentionsBatchHandler } from "./handlers/text";
import { tilesEnsureHandler } from "./handlers/tiles";
import { wikivoyageHandler } from "./handlers/wikivoyage";
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
  "fetch.source": fetchSourceHandler,
  "fetch.url": fetchUrlHandler,
  "embed.chunks": embedChunksHandler,
  "sources.wikivoyage": wikivoyageHandler,
  "compare.converters": compareConvertersHandler,
  "ai.batch.poll": aiBatchPollHandler,
  "classify.document_version": classifyDocumentVersionHandler,
  "mentions.batch": mentionsBatchHandler,
  "mentions.disambiguate": disambiguateMentionsHandler,
};
