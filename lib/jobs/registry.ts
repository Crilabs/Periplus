import { aiBatchPollHandler } from "./handlers/ai-batch";
import { compareConvertersHandler } from "./handlers/compare";
import { consolidationGeoHandler, consolidationSummaryHandler } from "./handlers/consolidation";
import { consolidationFollowupHandler } from "./handlers/consolidation-followup";
import { datasetsImportHandler } from "./handlers/datasets";
import { deliveryBuildHandler } from "./handlers/delivery";
import { discoveryAreaHandler, discoveryPlaceHandler, discoveryProposeHandler, discoveryTileHandler } from "./handlers/discovery";
import { embedChunksHandler } from "./handlers/embed";
import { fetchSourceHandler, fetchUrlHandler } from "./handlers/fetch";
import { gazetteerHandler } from "./handlers/gazetteer";
import { gazetteerCoarseHandler, subdivisionsBuildHandler } from "./handlers/subdivisions";
import { detectBaysHandler, geometryPlaceHandler } from "./handlers/geometry";
import { qualityMeasureHandler } from "./handlers/quality";
import { revisitFreezeHandler } from "./handlers/revisit";
import { advanceHandler } from "./handlers/run-advance";
import { seedTileHandler } from "./handlers/seed";
import { pingHandler } from "./handlers/system-ping";
import {
  classifyDocumentVersionHandler,
  disambiguateMentionsHandler,
  checkExtractionRunHandler,
  extractMentionsHandler,
  extractRoutesHandler,
  geocodeNameCandidateHandler,
  mentionsBatchHandler,
} from "./handlers/text";
import { tilesEnsureHandler } from "./handlers/tiles";
import { wikivoyageHandler } from "./handlers/wikivoyage";
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
  "datasets.import": datasetsImportHandler,
  "geometry.compute": geometryPlaceHandler,
  "geometry.detect_bays": detectBaysHandler,
  "discovery.area": discoveryAreaHandler,
  "discovery.tile": discoveryTileHandler,
  "discovery.propose": discoveryProposeHandler,
  "discovery.place": discoveryPlaceHandler,
  "fetch.source": fetchSourceHandler,
  "fetch.url": fetchUrlHandler,
  "embed.chunks": embedChunksHandler,
  "sources.wikivoyage": wikivoyageHandler,
  "compare.converters": compareConvertersHandler,
  "ai.batch.poll": aiBatchPollHandler,
  "classify.document_version": classifyDocumentVersionHandler,
  "mentions.batch": mentionsBatchHandler,
  "mentions.disambiguate": disambiguateMentionsHandler,
  "mentions.geocode": geocodeNameCandidateHandler,
  "extraction.mention": extractMentionsHandler,
  "extraction.route": extractRoutesHandler,
  "extraction.check": checkExtractionRunHandler,
  "consolidation.geo": consolidationGeoHandler,
  "consolidation.summary": consolidationSummaryHandler,
  "consolidation.followup": consolidationFollowupHandler,
  "delivery.build": deliveryBuildHandler,
  "quality.measure": qualityMeasureHandler,
  "revisit.freeze": revisitFreezeHandler,
};
