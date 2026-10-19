import { z } from "zod";
import { DOC_TYPES, type DocType } from "@/lib/db/schema/sources";
import type { ModelTask } from "../types";

/*
 * Document classification (spec 06): type, languages, dates and area hints of one document version, read from its
 * title, URL and first words. The output schema sent to the provider keeps to what structured outputs support
 * (types, enums, nullable): length, count and date-format limits are applied when the answer is stored
 * (`lib/domain/mentions/classification.ts`), so an over-long answer is trimmed instead of failing the item.
 */

export type ClassifyDocumentInput = { title: string | null; url: string; fetchedAt: string; text: string };

export type ClassifyDocumentOutput = {
  doc_type: DocType;
  /** ISO 639-1 codes; at most 5 are kept. */
  languages: string[];
  /** YYYY-MM-DD */
  published_at: string | null;
  /** YYYY-MM or YYYY-MM-DD */
  observed_at: string | null;
  observed_at_explicit: boolean;
  /** At most 300 characters are kept. */
  observed_at_reason: string | null;
  /** At most 10 are kept. */
  areas: string[];
};

const output: z.ZodType<ClassifyDocumentOutput> = z.object({
  doc_type: z.enum(DOC_TYPES),
  languages: z.array(z.string()),
  published_at: z.string().nullable(),
  observed_at: z.string().nullable(),
  observed_at_explicit: z.boolean(),
  observed_at_reason: z.string().nullable(),
  areas: z.array(z.string()),
});

export const classifyDocumentTask: ModelTask<ClassifyDocumentInput, ClassifyDocumentOutput> = {
  name: "classify-document",
  output,
  variables: (input) => ({
    title: input.title ?? "(none)",
    url: input.url,
    fetched_at: input.fetchedAt,
    doc_types: DOC_TYPES.join(", "),
    text: input.text,
  }),
};
