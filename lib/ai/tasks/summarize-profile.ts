import { z } from "zod";
import type { ModelTask } from "../types";

/*
 * The German summary of one consolidated profile (spec 07 `summary.de`): two to four sentences (one or two for a
 * highlight) written only from the profile's values, never from source texts. The output schema sent to the provider
 * is plain (`{ text }`); the length limit is checked when the answer arrives (ruling M5-P14, M4-D-R1), so an over-long
 * answer counts as a failed attempt.
 */

/** Characters a summary may have. */
export const SUMMARY_MAX_CHARS = 800;

export type SummarizeInput = {
  /** `spot`: an anchorage or harbour; `highlight`: a point of interest. */
  kind: "spot" | "highlight";
  name: string;
  /** Allowed number of sentences, inclusive. */
  sentences: [number, number];
  /** The profile is thinly supported: the text says so ("wenig belegt"). */
  lowConfidence: boolean;
  /** The profile values, labelled and formatted in German. */
  facts: Array<{ label: string; value: string }>;
  /** An earlier answer repeated a source text or missed the sentence count: write it in entirely own words. */
  avoid: boolean;
};

export type SummarizeOutput = { text: string };

const output: z.ZodType<SummarizeOutput> = z.object({ text: z.string().min(1).max(SUMMARY_MAX_CHARS) });

const yesNo = (b: boolean) => (b ? "yes" : "no");

export const summarizeProfileTask: ModelTask<SummarizeInput, SummarizeOutput> = {
  name: "summarize-profile",
  output,
  variables: (input) => ({
    kind: input.kind,
    name: input.name,
    min_sentences: String(input.sentences[0]),
    max_sentences: String(input.sentences[1]),
    low_confidence: yesNo(input.lowConfidence),
    rephrase: yesNo(input.avoid),
    max_chars: String(SUMMARY_MAX_CHARS),
    facts: input.facts.map((f) => `- ${f.label}: ${f.value}`).join("\n"),
  }),
};
