import { z } from "zod";
import type { PageKind } from "@/lib/db/schema/research";
import { toneEnum } from "@/lib/db/schema/research-extract";
import type { ModelTask } from "../types";

/*
 * Extraction of landside facts (plan N4b): from the text of one landside unit (a page found by searching a town or
 * sight near a confirmed berth, cut to the windows around those names) the facts about things on land: beaches,
 * tavernas, shops, villages, sights, transport. Never about anchoring or mooring of boats: such a page is no evidence
 * of a berth, and the output has no place for a signal, a core value or a landing hint. Quotes, dates and statements
 * are checked when the answer is stored (`storeExtraction`), so one bad element drops only itself.
 */

export type ExtractLandsideInput = {
  /** The berth the landside belongs to (its name only orients the model; nothing is extracted about it). */
  place: string;
  /** The towns and sights the page was searched for. */
  subjects: string[];
  pageKind: PageKind;
  /** The date the page counts as observed (YYYY-MM-DD). */
  observedAt: string;
  /** The unit text (the windows around the subject names). */
  text: string;
  /** Quote length limits (`extraction.quote`), stated in the prompt and checked on receipt. */
  limits: { quoteMinChars: number; quoteMaxChars: number };
};

export type ExtractLandsideOutput = {
  facts: Array<{
    subject_name: string | null;
    subject_category: string;
    statement: string;
    quote: string;
    observed_at: string | null;
    tone: "positive" | "negative" | "neutral";
    safety: boolean;
  }>;
};

const output: z.ZodType<ExtractLandsideOutput> = z.object({
  facts: z.array(
    z.object({
      subject_name: z.string().nullable(),
      subject_category: z.string(),
      statement: z.string(),
      quote: z.string(),
      observed_at: z.string().nullable(),
      tone: z.enum(toneEnum.enumValues),
      safety: z.boolean(),
    }),
  ),
});

export const extractLandsideTask: ModelTask<ExtractLandsideInput, ExtractLandsideOutput> = {
  name: "extract-landside",
  output,
  variables: (input) => ({
    quote_min_chars: String(input.limits.quoteMinChars),
    quote_max_chars: String(input.limits.quoteMaxChars),
    place: input.place,
    subjects: input.subjects.join(", "),
    page_kind: input.pageKind,
    observed_at: input.observedAt,
    text: input.text,
  }),
};
