import type { BatchHandlerEntry } from "@/lib/pipeline/batches";
import { assessPageBatchEntry } from "@/lib/pipeline/research/assess";
import { extractBerthBatchEntry } from "@/lib/pipeline/research/extract";
import { extractLandsideBatchEntry } from "@/lib/pipeline/research/landside-extract";
import { extractRouteBatchEntry } from "@/lib/pipeline/research/routes";
import { bundleFactsBatchEntry } from "@/lib/pipeline/research/state";

/**
 * The batch handler of each model task that runs as a message batch, by task name: the task (its output schema is
 * checked when collecting) and the function that stores one successful item. Tasks 7, 10, 13 and 16 add theirs.
 * Only the poll job handler (`./handlers/ai-batch`) imports this table; `pollBatch` takes it as a dependency, so the
 * stage modules it reaches never import the poll machinery back (ruling M4-P1).
 */
export const BATCH_HANDLERS: Record<string, BatchHandlerEntry> = {
  [extractRouteBatchEntry.task.name]: extractRouteBatchEntry,
  [assessPageBatchEntry.task.name]: assessPageBatchEntry,
  [extractBerthBatchEntry.task.name]: extractBerthBatchEntry,
  [extractLandsideBatchEntry.task.name]: extractLandsideBatchEntry,
  [bundleFactsBatchEntry.task.name]: bundleFactsBatchEntry,
};
