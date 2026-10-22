import type { StageDefinition } from "@/lib/pipeline/runs";
import { areaImportStage } from "./handlers/areas";
import { mentionsRereadStage } from "./handlers/reread";
import { compareConvertersStage } from "./handlers/compare";
import { consolidationFollowupStage, consolidationGeoStage, consolidationHighlightsStage, consolidationSummaryStage } from "./handlers/consolidation";
import { datasetsImportStage } from "./handlers/datasets";
import { deliveryBuildStage } from "./handlers/delivery";
import { discoveryAreaStage, discoveryPlaceStage, discoveryProposeStage, discoveryTileStage } from "./handlers/discovery";
import { embedChunksStage } from "./handlers/embed";
import { fetchSourceStage, fetchUrlStage } from "./handlers/fetch";
import { detectBaysStage, geometryPlaceStage } from "./handlers/geometry";
import { imagesPlaceStage } from "./handlers/images";
import { placeWebsiteFreezeStage, placeWebsiteStage } from "./handlers/place-website";
import {
  gazetteerGeonamesStage,
  gazetteerHierarchyStage,
  gazetteerOsmStage,
  gazetteerWikidataStage,
} from "./handlers/gazetteer";
import { seedTileStage } from "./handlers/seed";
import { gazetteerCoarseStage, subdivisionsBuildStage } from "./handlers/subdivisions";
import { qualityMeasureStage } from "./handlers/quality";
import { revisitFreezeStage } from "./handlers/revisit";
import { pingStage } from "./handlers/system-ping";
import {
  classifyDocumentVersionStage,
  extractionCheckStage,
  extractionMentionStage,
  extractionRouteStage,
  mentionsBatchStage,
  mentionsDisambiguateStage,
  mentionsGeocodeStage,
} from "./handlers/text";
import { tilesEnsureStage } from "./handlers/tiles";
import { wikivoyageStage } from "./handlers/wikivoyage";

/** Every stage a run may name, by stage name. Kept apart from HANDLERS so pipeline code can import it without a cycle. */
export const STAGES: Record<string, StageDefinition> = {
  [pingStage.name]: pingStage,
  [tilesEnsureStage.name]: tilesEnsureStage,
  [gazetteerOsmStage.name]: gazetteerOsmStage,
  [gazetteerWikidataStage.name]: gazetteerWikidataStage,
  [gazetteerGeonamesStage.name]: gazetteerGeonamesStage,
  [gazetteerHierarchyStage.name]: gazetteerHierarchyStage,
  [gazetteerCoarseStage.name]: gazetteerCoarseStage,
  [subdivisionsBuildStage.name]: subdivisionsBuildStage,
  [mentionsRereadStage.name]: mentionsRereadStage,
  [seedTileStage.name]: seedTileStage,
  [placeWebsiteStage.name]: placeWebsiteStage,
  [placeWebsiteFreezeStage.name]: placeWebsiteFreezeStage,
  [datasetsImportStage.name]: datasetsImportStage,
  [areaImportStage.name]: areaImportStage,
  [detectBaysStage.name]: detectBaysStage,
  [geometryPlaceStage.name]: geometryPlaceStage,
  [discoveryAreaStage.name]: discoveryAreaStage,
  [discoveryTileStage.name]: discoveryTileStage,
  [discoveryProposeStage.name]: discoveryProposeStage,
  [discoveryPlaceStage.name]: discoveryPlaceStage,
  [fetchSourceStage.name]: fetchSourceStage,
  [fetchUrlStage.name]: fetchUrlStage,
  [embedChunksStage.name]: embedChunksStage,
  [wikivoyageStage.name]: wikivoyageStage,
  [compareConvertersStage.name]: compareConvertersStage,
  [classifyDocumentVersionStage.name]: classifyDocumentVersionStage,
  [mentionsBatchStage.name]: mentionsBatchStage,
  [mentionsDisambiguateStage.name]: mentionsDisambiguateStage,
  [mentionsGeocodeStage.name]: mentionsGeocodeStage,
  [extractionMentionStage.name]: extractionMentionStage,
  [extractionRouteStage.name]: extractionRouteStage,
  [extractionCheckStage.name]: extractionCheckStage,
  [consolidationGeoStage.name]: consolidationGeoStage,
  [consolidationHighlightsStage.name]: consolidationHighlightsStage,
  [consolidationSummaryStage.name]: consolidationSummaryStage,
  [consolidationFollowupStage.name]: consolidationFollowupStage,
  [imagesPlaceStage.name]: imagesPlaceStage,
  [deliveryBuildStage.name]: deliveryBuildStage,
  [qualityMeasureStage.name]: qualityMeasureStage,
  [revisitFreezeStage.name]: revisitFreezeStage,
};
