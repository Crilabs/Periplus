import { z } from "zod";
import type { GeoObjectType } from "@/lib/db/schema";
import type { ModelTask } from "../types";

/*
 * Disambiguation of an ambiguous name match (spec 06): "mit Chunk und den 2–6 in Frage kommenden Objekten (Name, Typ,
 * Eltern, Koordinate)". The model picks the candidate the text means, or none.
 */

export type DisambiguateCandidate = { n: number; name: string; type: GeoObjectType; parents: string[]; lon: number; lat: number };

export type DisambiguateMentionInput = {
  /** The chunk around the name (at most `disambiguationContextChars`), the name marked as `[[surface]]`. */
  chunk: string;
  surface: string;
  candidates: DisambiguateCandidate[];
};

export type DisambiguateMentionOutput = {
  /** 0 = none of the candidates, else the candidate's `n`. */
  choice: number;
  /** 0–1 */
  confidence: number;
};

const output: z.ZodType<DisambiguateMentionOutput> = z.object({
  choice: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
});

/** A latitude or longitude with its hemisphere: 35.10000 N, 4.20000 W. */
const coordinate = (value: number, positive: string, negative: string) =>
  `${Math.abs(value).toFixed(5)} ${value < 0 ? negative : positive}`;

/** One candidate per line: `n. name (type) – in parent, grandparent – lat, lon` (with N/S and E/W). */
export function candidateList(candidates: DisambiguateCandidate[]): string {
  return candidates
    .map((c) => {
      const parents = c.parents.length > 0 ? ` – in ${c.parents.join(", ")}` : "";
      return `${c.n}. ${c.name} (${c.type})${parents} – ${coordinate(c.lat, "N", "S")}, ${coordinate(c.lon, "E", "W")}`;
    })
    .join("\n");
}

export const disambiguateMentionTask: ModelTask<DisambiguateMentionInput, DisambiguateMentionOutput> = {
  name: "disambiguate-mention",
  output,
  variables: (input) => ({ chunk: input.chunk, surface: input.surface, candidates: candidateList(input.candidates) }),
};
