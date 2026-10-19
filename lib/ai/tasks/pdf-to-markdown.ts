import { z } from "zod";
import type { ModelTask } from "../types";

/** One PDF page (a single-page PDF) as Markdown, for pages `pdftotext` cannot read. */
export const pdfToMarkdownTask: ModelTask<{ pdf: Uint8Array; page: number }, { markdown: string }> = {
  name: "pdf.to_markdown",
  output: z.object({ markdown: z.string() }),
  variables: (input) => ({ page: String(input.page) }),
  attachments: (input) => [{ kind: "pdf", data: input.pdf }],
};
