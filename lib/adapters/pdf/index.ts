import { createHash } from "node:crypto";
import type { ModelCallContext, ModelClient } from "@/lib/ai/types";
import { getConfig, type FetchConfig } from "@/lib/config";
import { layoutToMarkdown } from "@/lib/domain/documents/pdf-layout";
import type { Archive } from "../s3";
import { modelPagesToMarkdown } from "./claude";
import type { runPdftotext } from "./pdftotext";

export { hasPdftotext, runPdftotext } from "./pdftotext";
export { splitPdfPages } from "./split";

export type ConvertedPdf = {
  markdown: string;
  converter: "pdftotext" | "pdftotext+claude";
  /** Pages the model transcribed. */
  modelPages: number[];
  /** Unreadable pages left as `pdftotext` read them (no model, fallback off, or too many). */
  unreadablePages: number[];
};

/**
 * A PDF as Markdown: `pdftotext -layout` and `layoutToMarkdown` for every page. Unreadable pages are transcribed
 * by the model page by page (each call booked with `ctx`) when `cfg.modelFallback` is on, a model is given and
 * there are at most `cfg.maxModelPagesPerDocument` of them; otherwise they stay and are listed in
 * `unreadablePages`. When the model budget runs out midway, the pages already transcribed are kept and the rest stay
 * as `pdftotext` read them (in `unreadablePages`), as does a page whose model answer is invalid. With an `archive`,
 * every transcribed page is kept under `pdfPageCachePrefix` (PDF hash, model, prompt version), so a retried or
 * repeated job pays only for the pages still missing.
 */
export async function convertPdf(
  bytes: Uint8Array,
  deps: { pdftotext: typeof runPdftotext; model?: ModelClient; cfg: FetchConfig["pdf"]; archive?: Archive },
  ctx: ModelCallContext,
): Promise<ConvertedPdf> {
  const { cfg } = deps;
  const { markdown, pages } = layoutToMarkdown(await deps.pdftotext(bytes), cfg.unreadableMinChars);
  const unreadable = pages.filter((p) => p.unreadable).map((p) => p.page);
  const useModel = unreadable.length > 0 && cfg.modelFallback && deps.model && unreadable.length <= cfg.maxModelPagesPerDocument;
  if (!useModel) return { markdown, converter: "pdftotext", modelPages: [], unreadablePages: unreadable };

  const cache = deps.archive ? { archive: deps.archive, prefix: pdfPageCachePrefix(bytes) } : undefined;
  const byModel = await modelPagesToMarkdown(bytes, unreadable, deps.model!, ctx, cache);
  if (byModel.size === 0) return { markdown, converter: "pdftotext", modelPages: [], unreadablePages: unreadable };
  const sections = pages.map((p) => {
    const transcribed = byModel.get(p.page);
    if (transcribed === undefined) return p.markdown;
    const marker = `<!-- page ${p.page} -->`;
    return transcribed ? `${marker}\n\n${transcribed}` : marker;
  });
  return {
    markdown: sections.join("\n\n"),
    converter: "pdftotext+claude",
    modelPages: unreadable.filter((p) => byModel.has(p)),
    unreadablePages: unreadable.filter((p) => !byModel.has(p)),
  };
}

/**
 * Archive prefix of the model transcriptions of a PDF: `pdf-pages/<sha256>/<model>/v<promptVersion>` of the task
 * `pdf.to_markdown` (`config/models.json`), so another model or prompt transcribes anew.
 */
export function pdfPageCachePrefix(bytes: Uint8Array): string {
  const task = getConfig().models.tasks["pdf.to_markdown"];
  if (!task) throw new Error("No model configured for task pdf.to_markdown in config/models.json");
  const sha = createHash("sha256").update(bytes).digest("hex");
  return `pdf-pages/${sha}/${task.model}/v${task.promptVersion}`;
}
