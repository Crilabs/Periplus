import type { BatchHandlerEntry } from "@/lib/pipeline/batches";
import { assessPageBatchEntry } from "@/lib/pipeline/research/assess";
import { extractBerthBatchEntry } from "@/lib/pipeline/research/extract";
import { extractLandsideBatchEntry } from "@/lib/pipeline/research/landside-extract";
import { extractRouteBatchEntry, RESEARCH_ROUTES_STAGE } from "@/lib/pipeline/research/routes";
import { bundleFactsBatchEntry } from "@/lib/pipeline/research/state";
import { classificationBatchEntry } from "@/lib/pipeline/text/classify";
import { disambiguationBatchEntry } from "@/lib/pipeline/text/disambiguate";
import { extractFactsBatchEntry } from "@/lib/pipeline/text/extract";
import { routeSectionBatchEntry } from "@/lib/pipeline/text/routes";

/** `extract-route` serves `research.routes` and the old `extraction.route`; dispatched by the batch's stage. */
const routeBatchEntry: BatchHandlerEntry = {
  task: extractRouteBatchEntry.task,
  handle: (db, item, ctx) => (item.batch.stage === RESEARCH_ROUTES_STAGE ? extractRouteBatchEntry.handle(db, item, ctx) : routeSectionBatchEntry.handle(db, item, ctx)),
};

/**
 * The batch handler of each model task that runs as a message batch, by task name: the task (its output schema is
 * checked when collecting) and the function that stores one successful item. Tasks 7, 10, 13 and 16 add theirs.
 * Only the poll job handler (`./handlers/ai-batch`) imports this table; `pollBatch` takes it as a dependency, so the
 * stage modules it reaches never import the poll machinery back (ruling M4-P1).
 */
export const BATCH_HANDLERS: Record<string, BatchHandlerEntry> = {
  [classificationBatchEntry.task.name]: classificationBatchEntry,
  [disambiguationBatchEntry.task.name]: disambiguationBatchEntry,
  [extractFactsBatchEntry.task.name]: extractFactsBatchEntry,
  [routeBatchEntry.task.name]: routeBatchEntry,
  [assessPageBatchEntry.task.name]: assessPageBatchEntry,
  [extractBerthBatchEntry.task.name]: extractBerthBatchEntry,
  [extractLandsideBatchEntry.task.name]: extractLandsideBatchEntry,
  [bundleFactsBatchEntry.task.name]: bundleFactsBatchEntry,
};
