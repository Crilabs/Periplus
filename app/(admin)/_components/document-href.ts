import type { FactView } from "@/lib/domain/geo-facts";

/** The document page of a fact's quote: its version, tab "Erwähnungen und Zitate", where the quote is highlighted. */
export const documentHref = (f: Pick<FactView, "documentId" | "documentVersionId">) =>
  `/documents/${f.documentId}${f.documentVersionId ? `?v=${f.documentVersionId}&tab=annotations` : "?tab=annotations"}`;
