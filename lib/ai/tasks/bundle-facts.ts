import { z } from "zod";
import type { Tone } from "@/lib/db/schema/research-extract";
import type { ModelTask } from "../types";

/*
 * Bundling the free facts of one berth (plan N4a task 3): the model groups facts that say the same about the same
 * subject, names the clearest one of each group as its representative and the ids a newer fact of the group
 * contradicts. It writes no text: the representative is always one of the given facts. The ids are checked when the
 * answer is stored (`lib/domain/research/state-facts.ts`).
 */

export type BundleFactInput = {
  id: string;
  subject: "berth" | "landside";
  subjectName: string | null;
  statement: string;
  /** YYYY-MM-DD */
  observedAt: string;
  tone: Tone | null;
};

export type BundleFactsInput = { facts: BundleFactInput[] };

export type BundleFactsOutput = { groups: Array<{ ids: string[]; representative: string; superseded: string[] }> };

const output: z.ZodType<BundleFactsOutput> = z.object({
  groups: z.array(z.object({ ids: z.array(z.string()), representative: z.string(), superseded: z.array(z.string()) })),
});

/** One line per fact; statements are single-line text in the prompt. */
export function factLine(f: BundleFactInput): string {
  const subject = f.subject === "landside" ? `landside${f.subjectName ? `: ${f.subjectName}` : ""}` : "the berth";
  return `${f.id} | ${f.observedAt} | ${f.tone ?? "no tone"} | ${subject} | ${f.statement.replace(/\s+/g, " ").trim()}`;
}

export const bundleFactsTask: ModelTask<BundleFactsInput, BundleFactsOutput> = {
  name: "bundle-facts",
  output,
  variables: (input) => ({ facts: input.facts.map(factLine).join("\n") }),
};
