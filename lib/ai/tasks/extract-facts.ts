import { z } from "zod";
import { EXPOSURE_SCALE, TEXT_SCALE } from "@/config/fact-schema/v2";
import type { GeoObjectType } from "@/lib/db/schema/geo";
import type { DocType } from "@/lib/db/schema/sources";
import { attributesForPrompt, nameValuesForPrompt } from "@/lib/domain/facts/schema";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import type { ModelTask } from "../types";

/*
 * Fact extraction (spec 06): the facts a text states about one geo object, from the chunks of one extraction unit
 * (the chunks mentioning the object and their neighbours). Every fact carries a verbatim quote and the number of the
 * chunk it comes from; the value is JSON text in the attribute's format (language-neutral: enums, numbers, proper
 * names), checked against the fact schema on receipt. The system prompt holds only what is the same for every unit of
 * a level (level, attribute list, word scales, the fact limit), so it can be cached (ruling M4-P20). The output schema keeps to what
 * structured outputs support; lengths, counts and ranges are enforced when the answer is processed
 * (`lib/domain/extraction/facts.ts`), so one over-long field drops one fact instead of the whole answer.
 */

export type ExtractFactsInput = {
  level: FactLevel;
  /** The fact schema version of the extraction run (frozen at plan time): the attribute list comes from it. */
  factSchemaVersion: string;
  /** At most this many facts are looked at (`extraction.maxFactsPerUnit`); the same for every request. */
  maxFacts: number;
  object: { name: string; type: GeoObjectType; parents: string[] };
  docType: DocType;
  observedAt: string;
  /** The unit's chunks in text order, numbered from 1. */
  chunks: Array<{ n: number; text: string }>;
};

export type ExtractedFact = {
  attribute: string;
  /** JSON text of the value in the attribute's format. */
  value: string;
  /** Verbatim excerpt of the chunk, at most 300 characters (checked on receipt). */
  quote: string;
  /** Number of the chunk the quote comes from. */
  chunk: number;
  /** 0–1 (clamped on receipt). */
  confidence: number;
  /** YYYY-MM-DD or YYYY-MM, only when the text states it. */
  observed_at: string | null;
  /** For `highlight.*`: the proper name of the highlight, at most 80 characters (checked on receipt). */
  poi_name: string | null;
};

export type ExtractFactsOutput = { facts: ExtractedFact[] };

const output: z.ZodType<ExtractFactsOutput> = z.object({
  facts: z.array(
    z.object({
      attribute: z.string(),
      value: z.string(),
      quote: z.string(),
      chunk: z.number().int(),
      confidence: z.number(),
      observed_at: z.string().nullable(),
      poi_name: z.string().nullable(),
    }),
  ),
});

/** Typical wordings per scale word, in the languages of the pilot texts, so the model can pick the word. */
const SHELTER_WORDINGS: Record<keyof typeof TEXT_SCALE, string> = {
  good: "well sheltered, good protection, calm (de: gut geschützt; el: καλά προστατευμένο)",
  moderate: "some protection, partly open, can get rolly (de: mäßig geschützt)",
  poor: "open, exposed, no protection (de: kein Schutz, offen)",
};
const EXPOSURE_WORDINGS: Record<keyof typeof EXPOSURE_SCALE, string> = {
  low: "little or no meltemi, sheltered from it",
  moderate: "some meltemi, exposed at times",
  high: "fully exposed, the meltemi blows hard",
};

function scaleTable<K extends string>(title: string, scale: Record<K, number>, wordings: Record<K, string>): string {
  const rows = (Object.keys(scale) as K[]).map((word) => `| ${word} | ${wordings[word]} | ${scale[word]} |`);
  return [title, "| word | when the text says, for example | stored as |", "| --- | --- | --- |", ...rows].join("\n");
}

/**
 * The word scales of a level as Markdown tables (the prompt's mappings): the model answers with the word, Periplus
 * stores the number (spec 06: "gut/mäßig/kein Schutz" → 0.9 / 0.5 / 0.1).
 */
export function mappingTable(level: FactLevel): string {
  if (level === "place") {
    return scaleTable("Shelter scale, for shelter.<sector> and swell_protection:", TEXT_SCALE, SHELTER_WORDINGS);
  }
  if (level === "area" || level === "island") {
    return scaleTable("Exposure scale, for meltemi_exposure:", EXPOSURE_SCALE, EXPOSURE_WORDINGS);
  }
  return "No word scales on this level.";
}

/** `name (type) – in parent, grandparent` */
export function objectLine(object: ExtractFactsInput["object"]): string {
  const parents = object.parents.length > 0 ? ` – in ${object.parents.join(", ")}` : "";
  return `${object.name} (${object.type})${parents}`;
}

/** The chunks as `<chunk n="1">…</chunk>` blocks. */
export function chunkBlocks(chunks: ExtractFactsInput["chunks"]): string {
  return chunks.map((c) => `<chunk n="${c.n}">\n${c.text}\n</chunk>`).join("\n\n");
}

export const extractFactsTask: ModelTask<ExtractFactsInput, ExtractFactsOutput> = {
  name: "extract-facts",
  output,
  variables: (input) => ({
    level: input.level,
    attributes: attributesForPrompt(input.level, input.factSchemaVersion),
    name_values: nameValuesForPrompt(input.level, input.factSchemaVersion),
    max_facts: String(input.maxFacts),
    mappings: mappingTable(input.level),
    object: objectLine(input.object),
    doc_type: input.docType,
    observed_at: input.observedAt,
    chunks: chunkBlocks(input.chunks),
  }),
};
