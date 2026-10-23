import { z } from "zod";
import { pageKindEnum, type AssessedBerth } from "@/lib/db/schema/research";
import type { ModelTask } from "../types";

/*
 * Page assessment (spec 18, plan N1): what kind of page a research hit is, whether it reports first-hand, whether it
 * reads as mass-produced text, and which berths it treats. The output schema sent to the provider keeps to what
 * structured outputs support (types, enums, nullable): the date format, length and count limits are applied when the
 * answer is stored (`lib/domain/research/assessment.ts`).
 */

export type AssessPageInput = { url: string; title: string | null; fetchedAt: string; publishedAt: string | null; text: string };

export type AssessPageOutput = {
  page_kind: (typeof pageKindEnum.enumValues)[number];
  first_hand: boolean;
  generated: boolean;
  /** ISO 639-1 code of the main language. */
  language: string | null;
  /** YYYY-MM or YYYY-MM-DD */
  observed_at: string | null;
  observed_at_explicit: boolean;
  /** At most 300 characters are kept. */
  observed_at_reason: string | null;
  /** At most 50 are kept. */
  berths: AssessedBerth[];
};

const output: z.ZodType<AssessPageOutput> = z.object({
  page_kind: z.enum(pageKindEnum.enumValues),
  first_hand: z.boolean(),
  generated: z.boolean(),
  language: z.string().nullable(),
  observed_at: z.string().nullable(),
  observed_at_explicit: z.boolean(),
  observed_at_reason: z.string().nullable(),
  berths: z.array(
    z.object({
      name: z.string(),
      island: z.string().nullable(),
      kind: z.enum(["anchorage", "mooring_field", "marina", "port", "unknown"]),
    }),
  ),
});

export const assessPageTask: ModelTask<AssessPageInput, AssessPageOutput> = {
  name: "assess-page",
  output,
  variables: (input) => ({
    title: input.title ?? "(none)",
    url: input.url,
    fetched_at: input.fetchedAt,
    published_at: input.publishedAt ?? "(unknown)",
    page_kinds: pageKindEnum.enumValues.join(", "),
    text: input.text,
  }),
};
