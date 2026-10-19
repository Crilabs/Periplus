import type { ModelCallContext, ModelClient } from "@/lib/ai/types";
import { BudgetExceeded } from "@/lib/domain/costs";
import { pdfToMarkdownTask } from "@/lib/ai/tasks/pdf-to-markdown";
import { splitPdfPages } from "./split";

/**
 * Markdown of the given pages (1-based) by the model, one call per page with that page as a single-page PDF. When the
 * model budget runs out midway, the pages done so far are returned (they are paid) and the rest are missing.
 */
export async function modelPagesToMarkdown(
  bytes: Uint8Array,
  pages: number[],
  model: ModelClient,
  ctx: ModelCallContext,
): Promise<Map<number, string>> {
  const singles = await splitPdfPages(bytes, pages);
  const out = new Map<number, string>();
  for (const [i, page] of pages.entries()) {
    try {
      const { output } = await model.call(pdfToMarkdownTask, { pdf: singles[i]!, page }, ctx);
      out.set(page, output.markdown.trim());
    } catch (error) {
      if (error instanceof BudgetExceeded) break;
      throw error;
    }
  }
  return out;
}
