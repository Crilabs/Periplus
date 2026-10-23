import { z } from "zod";
import type { PlaceKind } from "@/lib/db/schema/geo";
import type { PageKind } from "@/lib/db/schema/research";
import { berthSignalKindEnum, toneEnum, type BerthSignalKind } from "@/lib/db/schema/research-extract";
import type { ModelTask } from "../types";

/*
 * Extraction per page and berth (spec 18, plan N2): from the text of one research unit (one page version read for one
 * berth candidate) the core values of the berth (fact schema v4, place level), free facts in the model's own words,
 * berth signals (was someone there, is it listed, is it forbidden or gone) and landing hints, each with a verbatim
 * quote. The system prompt holds only what is the same for every unit (rules, attribute list, signal kinds, limits),
 * so it can be cached. The output schema keeps to what structured outputs support: a core value is JSON text (like
 * `extract-facts`), and quotes, values, statements, dates and confidences are checked when the answer is stored
 * (`lib/domain/research/extraction.ts`), so one bad element drops only itself.
 */

export type ExtractBerthInput = {
  berth: { name: string; names: string[]; kind: PlaceKind; island: string | null };
  /** Display names of the other berths the page treats (other units of the same page): never extract for them. */
  otherBerths: string[];
  pageKind: PageKind;
  /** The date the page counts as observed (YYYY-MM-DD). */
  observedAt: string;
  /** The text attributes of the fact schema, with the value format as JSON Schema text. */
  attributes: Array<{ key: string; description: string; values: string }>;
  /** The unit text (whole page or windows around the berth's names). */
  text: string;
  /** Quote length limits (`extraction.quote`), stated in the prompt and checked on receipt. */
  limits: { quoteMinChars: number; quoteMaxChars: number };
};

export type ExtractBerthOutput = {
  /** `value`: JSON text in the attribute's format; a bare word is read as a string (checked on receipt). */
  core: Array<{ attribute: string; value: unknown; quote: string }>;
  facts: Array<{
    about: "berth" | "landside";
    subject_name: string | null;
    subject_category: string | null;
    statement: string;
    quote: string;
    observed_at: string | null;
    tone: "positive" | "negative" | "neutral";
    safety: boolean;
  }>;
  /** `confidence` 0–1 (a signal outside is dropped on receipt). */
  signals: Array<{ kind: BerthSignalKind; first_hand: boolean; confidence: number; quote: string; observed_at: string | null }>;
  landing: Array<{ description: string; quote: string }>;
};

const output: z.ZodType<ExtractBerthOutput> = z.object({
  core: z.array(z.object({ attribute: z.string(), value: z.string(), quote: z.string() })),
  facts: z.array(
    z.object({
      about: z.enum(["berth", "landside"]),
      subject_name: z.string().nullable(),
      subject_category: z.string().nullable(),
      statement: z.string(),
      quote: z.string(),
      observed_at: z.string().nullable(),
      tone: z.enum(toneEnum.enumValues),
      safety: z.boolean(),
    }),
  ),
  signals: z.array(
    z.object({
      kind: z.enum(berthSignalKindEnum.enumValues),
      first_hand: z.boolean(),
      confidence: z.number(),
      quote: z.string(),
      observed_at: z.string().nullable(),
    }),
  ),
  landing: z.array(z.object({ description: z.string(), quote: z.string() })),
});

/** `Name (kind) – on Island; also called A, B` */
export function berthLine(berth: ExtractBerthInput["berth"]): string {
  const island = berth.island ? ` – on ${berth.island}` : "";
  const others = [...new Set(berth.names)].filter((n) => n !== berth.name);
  const aka = others.length > 0 ? `; also called ${others.join(", ")}` : "";
  return `${berth.name} (${berth.kind})${island}${aka}`;
}

export const extractBerthTask: ModelTask<ExtractBerthInput, ExtractBerthOutput> = {
  name: "extract-berth",
  output,
  variables: (input) => ({
    attributes: input.attributes.map((a) => `${a.key} — ${a.description} — ${a.values}`).join("\n"),
    signal_kinds: berthSignalKindEnum.enumValues.join(", "),
    quote_min_chars: String(input.limits.quoteMinChars),
    quote_max_chars: String(input.limits.quoteMaxChars),
    berth: berthLine(input.berth),
    other_berths: input.otherBerths.length > 0 ? input.otherBerths.join(", ") : "(none)",
    page_kind: input.pageKind,
    observed_at: input.observedAt,
    text: input.text,
  }),
};
