import type { StageDefinition } from "@/lib/pipeline/runs";
import { areaImportStage } from "./handlers/areas";
import { datasetsImportStage } from "./handlers/datasets";
import { deliveryBuildStage } from "./handlers/delivery";
import { detectBaysStage, geometryPlaceStage } from "./handlers/geometry";
import {
  researchAssessStage,
  researchConfirmStage,
  researchDiscoverStage,
  researchExtractStage,
  researchFetchStage,
  researchRoutesStage,
  researchSearchStage,
  researchLandsideExtractStage,
  researchLandsideSearchStage,
  researchStateFactsStage,
  researchStateStage,
} from "./handlers/research";
import { imagesPlaceStage } from "./handlers/images";
import { placeWebsiteStage } from "./handlers/place-website";
import {
  gazetteerGeonamesStage,
  gazetteerHierarchyStage,
  gazetteerLandStage,
  gazetteerOsmStage,
  gazetteerWikidataStage,
} from "./handlers/gazetteer";
import { seedTileStage } from "./handlers/seed";
import { gazetteerCoarseStage, gazetteerSeasStage, subdivisionsAssignStage, subdivisionsBuildStage } from "./handlers/subdivisions";
import { pingStage } from "./handlers/system-ping";
import { tilesEnsureStage } from "./handlers/tiles";

/** Every stage a run may name, by stage name. Kept apart from HANDLERS so pipeline code can import it without a cycle. */
export const STAGES: Record<string, StageDefinition> = {
  [pingStage.name]: pingStage,
  [tilesEnsureStage.name]: tilesEnsureStage,
  [gazetteerOsmStage.name]: gazetteerOsmStage,
  [gazetteerWikidataStage.name]: gazetteerWikidataStage,
  [gazetteerGeonamesStage.name]: gazetteerGeonamesStage,
  [gazetteerHierarchyStage.name]: gazetteerHierarchyStage,
  [gazetteerLandStage.name]: gazetteerLandStage,
  [gazetteerSeasStage.name]: gazetteerSeasStage,
  [gazetteerCoarseStage.name]: gazetteerCoarseStage,
  [subdivisionsBuildStage.name]: subdivisionsBuildStage,
  [subdivisionsAssignStage.name]: subdivisionsAssignStage,
  [seedTileStage.name]: seedTileStage,
  [placeWebsiteStage.name]: placeWebsiteStage,
  [datasetsImportStage.name]: datasetsImportStage,
  [areaImportStage.name]: areaImportStage,
  [detectBaysStage.name]: detectBaysStage,
  [geometryPlaceStage.name]: geometryPlaceStage,
  [researchSearchStage.name]: researchSearchStage,
  [researchFetchStage.name]: researchFetchStage,
  [researchAssessStage.name]: researchAssessStage,
  [researchExtractStage.name]: researchExtractStage,
  [researchRoutesStage.name]: researchRoutesStage,
  [researchDiscoverStage.name]: researchDiscoverStage,
  [researchConfirmStage.name]: researchConfirmStage,
  [researchStateStage.name]: researchStateStage,
  [researchStateFactsStage.name]: researchStateFactsStage,
  [researchLandsideSearchStage.name]: researchLandsideSearchStage,
  [researchLandsideExtractStage.name]: researchLandsideExtractStage,
  [imagesPlaceStage.name]: imagesPlaceStage,
  [deliveryBuildStage.name]: deliveryBuildStage,
};
