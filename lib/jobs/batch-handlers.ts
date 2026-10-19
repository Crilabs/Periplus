import type { BatchHandlerEntry } from "@/lib/pipeline/batches";
import { classificationBatchEntry } from "@/lib/pipeline/text/classify";
import { disambiguationBatchEntry } from "@/lib/pipeline/text/disambiguate";
import { extractFactsBatchEntry } from "@/lib/pipeline/text/extract";

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
};
