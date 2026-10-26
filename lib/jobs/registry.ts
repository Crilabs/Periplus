import { aiBatchPollHandler } from "./handlers/ai-batch";
import { areaImportHandler } from "./handlers/areas";
import { datasetsImportHandler } from "./handlers/datasets";
import { deliveryBuildHandler } from "./handlers/delivery";
import { gazetteerHandler } from "./handlers/gazetteer";
import {
  researchAssessHandler,
  researchDiscoverHandler,
  researchExtractHandler,
  researchFetchHandler,
  researchRoutesHandler,
  researchSearchHandler,
  researchLandsideExtractHandler,
  researchLandsideSearchHandler,
  researchStateFactsHandler,
  researchStateHandler,
} from "./handlers/research";
import { researchConfirmHandler } from "./handlers/research-confirm";
import { imagesPlaceHandler } from "./handlers/images";
import { placeWebsiteHandler } from "./handlers/place-website";
import { gazetteerCoarseHandler, subdivisionsBuildHandler } from "./handlers/subdivisions";
import { detectBaysHandler, geometryPlaceHandler } from "./handlers/geometry";
import { advanceHandler } from "./handlers/run-advance";
import { seedTileHandler } from "./handlers/seed";
import { pingHandler } from "./handlers/system-ping";
import { tilesEnsureHandler } from "./handlers/tiles";
import { onRunEnded } from "@/lib/pipeline/run-ended";
import { afterBuildRunEnded } from "@/lib/pipeline/subdivision-build";
import type { QueueName } from "./queues";
import type { JobData, JobHandler } from "./worker";

// The end of a subdivision build sets `built_at` and starts the next queued subdivision of its country (spec 14).
onRunEnded(afterBuildRunEnded);

/** The handler the worker runs for each queue. */
export const HANDLERS: Record<QueueName, JobHandler<JobData>> = {
  "system.ping": pingHandler,
  "run.advance": advanceHandler,
  "tiles.ensure": tilesEnsureHandler,
  "gazetteer.build": gazetteerHandler,
  "gazetteer.coarse": gazetteerCoarseHandler,
  "subdivisions.build": subdivisionsBuildHandler,
  "seed.tile": seedTileHandler,
  "places.website": placeWebsiteHandler,
  "datasets.import": datasetsImportHandler,
  "areas.import": areaImportHandler,
  "geometry.compute": geometryPlaceHandler,
  "geometry.detect_bays": detectBaysHandler,
  "research.search": researchSearchHandler,
  "research.fetch": researchFetchHandler,
  "research.assess": researchAssessHandler,
  "research.extract": researchExtractHandler,
  "research.routes": researchRoutesHandler,
  "research.discover": researchDiscoverHandler,
  "research.confirm": researchConfirmHandler,
  "research.state": researchStateHandler,
  "research.state_facts": researchStateFactsHandler,
  "research.landside_search": researchLandsideSearchHandler,
  "research.landside_extract": researchLandsideExtractHandler,
  "ai.batch.poll": aiBatchPollHandler,
  "images.place": imagesPlaceHandler,
  "delivery.build": deliveryBuildHandler,
};
