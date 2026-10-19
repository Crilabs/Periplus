import type { StageDefinition } from "@/lib/pipeline/runs";
import { compareConvertersStage } from "./handlers/compare";
import { datasetsImportStage } from "./handlers/datasets";
import { discoveryAreaStage, discoveryProposeStage, discoveryTileStage } from "./handlers/discovery";
import { embedChunksStage } from "./handlers/embed";
import { fetchSourceStage, fetchUrlStage } from "./handlers/fetch";
import { geometryPlaceStage } from "./handlers/geometry";
import {
  gazetteerGeonamesStage,
  gazetteerHierarchyStage,
  gazetteerOsmStage,
  gazetteerWikidataStage,
} from "./handlers/gazetteer";
import { seedTileStage } from "./handlers/seed";
import { pingStage } from "./handlers/system-ping";
import { classifyDocumentVersionStage, mentionsBatchStage, mentionsDisambiguateStage } from "./handlers/text";
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
  [seedTileStage.name]: seedTileStage,
  [datasetsImportStage.name]: datasetsImportStage,
  [geometryPlaceStage.name]: geometryPlaceStage,
  [discoveryAreaStage.name]: discoveryAreaStage,
  [discoveryTileStage.name]: discoveryTileStage,
  [discoveryProposeStage.name]: discoveryProposeStage,
  [fetchSourceStage.name]: fetchSourceStage,
  [fetchUrlStage.name]: fetchUrlStage,
  [embedChunksStage.name]: embedChunksStage,
  [wikivoyageStage.name]: wikivoyageStage,
  [compareConvertersStage.name]: compareConvertersStage,
  [classifyDocumentVersionStage.name]: classifyDocumentVersionStage,
  [mentionsBatchStage.name]: mentionsBatchStage,
  [mentionsDisambiguateStage.name]: mentionsDisambiguateStage,
};
