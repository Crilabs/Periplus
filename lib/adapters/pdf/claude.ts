import { ModelOutputInvalid, type ModelCallContext, type ModelClient } from "@/lib/ai/types";
import { BudgetExceeded } from "@/lib/domain/costs";
import { pdfToMarkdownTask } from "@/lib/ai/tasks/pdf-to-markdown";
import type { Archive } from "../s3";
import { splitPdfPages } from "./split";

/** Where transcribed pages are kept: `<prefix>/<page>.md` in the archive. */
export type PageCache = { archive: Archive; prefix: string };

/**
 * Markdown of the given pages (1-based) by the model, one call per page with that page as a single-page PDF. With a
 * `cache`, a page transcribed before (e.g. by an earlier attempt of the same job) is read from the archive and not
 * paid again, and every newly transcribed page is stored there at once. When the model budget runs out midway, the
 * pages done so far are returned (they are paid) and the rest are missing; a page whose answer is invalid is left
 * out (missing); any other error is thrown, the pages paid so far stay in the cache.
 */
export async function modelPagesToMarkdown(
  bytes: Uint8Array,
  pages: number[],
  model: ModelClient,
  ctx: ModelCallContext,
  cache?: PageCache,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const keyOf = (page: number) => `${cache!.prefix}/${page}.md`;
  const missing: number[] = [];
  for (const page of pages) {
    const cached = cache ? await cache.archive.get(keyOf(page)) : null;
    if (cached) out.set(page, new TextDecoder().decode(cached));
    else missing.push(page);
  }
  const singles = await splitPdfPages(bytes, missing);
  for (const [i, page] of missing.entries()) {
    try {
      const { output } = await model.call(pdfToMarkdownTask, { pdf: singles[i]!, page }, ctx);
      const markdown = output.markdown.trim();
      if (cache) await cache.archive.put(keyOf(page), markdown, "text/markdown; charset=utf-8");
      out.set(page, markdown);
    } catch (error) {
      if (error instanceof BudgetExceeded) break;
      if (error instanceof ModelOutputInvalid) continue;
      throw error;
    }
  }
  return out;
}
