import { MockModel } from "@/lib/ai/mock";
import type { ClassifyDocumentInput } from "@/lib/ai/tasks/classify-document";
import type { ExtractedFact, ExtractFactsInput } from "@/lib/ai/tasks/extract-facts";
import { newId } from "@/lib/domain/ids";
import { REVISIT_SOURCES } from "./area";

/*
 * The model of the revisit integration test (plan Task 14): no network, every answer derived from the input. The
 * classification follows the source type of the page's host; the fact extraction is rule-based on the sentences of the
 * unit's chunks, each fact quoting its sentence verbatim, and only for places (bays, harbours), never for the island:
 *
 *   „Die Taverne (\w+) ist im Sommer geöffnet.“ → highlight.food { present: true, names: [$1] }
 *   „Die Taverne (\w+) hat geschlossen.“        → highlight.food { present: false, names: [$1] }
 *   „Ankertiefe (\d+) m“                         → depth.min $1
 *   „Bojen sind ausgelegt.“ / „Die Bojen wurden entfernt.“ → mooring.buoys { present: true / false }
 *   „Swimming is prohibited …“ / „Anchoring is prohibited …“ → prohibitions [{ kind, months: null }]
 */

type Rule = { pattern: RegExp; fact: (m: RegExpMatchArray) => Pick<ExtractedFact, "attribute" | "value" | "poi_name"> };

const RULES: Rule[] = [
  {
    pattern: /Die Taverne (\w+) ist im Sommer geöffnet\./,
    fact: (m) => ({ attribute: "highlight.food", value: JSON.stringify({ present: true, names: [m[1]] }), poi_name: m[1]! }),
  },
  {
    pattern: /Die Taverne (\w+) hat geschlossen\./,
    fact: (m) => ({ attribute: "highlight.food", value: JSON.stringify({ present: false, names: [m[1]] }), poi_name: m[1]! }),
  },
  { pattern: /Ankertiefe (\d+) m/, fact: (m) => ({ attribute: "depth.min", value: m[1]!, poi_name: null }) },
  { pattern: /Bojen sind ausgelegt\./, fact: () => ({ attribute: "mooring.buoys", value: JSON.stringify({ present: true, count: null, paid: null }), poi_name: null }) },
  {
    pattern: /Die Bojen wurden entfernt\./,
    fact: () => ({ attribute: "mooring.buoys", value: JSON.stringify({ present: false, count: null, paid: null }), poi_name: null }),
  },
  { pattern: /Swimming is prohibited\b/, fact: () => ({ attribute: "prohibitions", value: JSON.stringify([{ kind: "swimming", months: null }]), poi_name: null }) },
  { pattern: /Anchoring is prohibited\b/, fact: () => ({ attribute: "prohibitions", value: JSON.stringify([{ kind: "anchoring", months: null }]), poi_name: null }) },
];

const PLACE_TYPES = new Set(["bay", "harbour", "cove", "anchorage"]);

/**
 * The facts the rules find in the unit's chunks, each quoting its sentence. Like a real answer, one fact per attribute
 * (the extraction keeps one of an attribute proposed twice): the bans of one chunk become one `prohibitions` list
 * quoting the span from the first to the last ban sentence.
 */
export function revisitFacts(input: ExtractFactsInput): ExtractedFact[] {
  if (!PLACE_TYPES.has(input.object.type)) return [];
  const facts: ExtractedFact[] = [];
  for (const chunk of input.chunks) {
    const found: Array<{ fact: ExtractedFact; start: number; end: number }> = [];
    for (const sentence of chunk.text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim())) {
      for (const rule of RULES) {
        const m = sentence.match(rule.pattern);
        if (!m) continue;
        const start = chunk.text.indexOf(sentence);
        found.push({ fact: { ...rule.fact(m), quote: sentence, chunk: chunk.n, confidence: 0.9, observed_at: null }, start, end: start + sentence.length });
      }
    }
    for (const attribute of [...new Set(found.map((f) => f.fact.attribute))]) {
      const same = found.filter((f) => f.fact.attribute === attribute);
      if (same.length === 1 || attribute !== "prohibitions") {
        facts.push(same[0]!.fact);
        continue;
      }
      const start = Math.min(...same.map((f) => f.start));
      const end = Math.max(...same.map((f) => f.end));
      const value = JSON.stringify(same.flatMap((f) => JSON.parse(f.fact.value) as unknown[]));
      facts.push({ ...same[0]!.fact, value, quote: chunk.text.slice(start, end) });
    }
  }
  return facts;
}

/** The answering model; `seen` counts the extraction requests per object name (what the revisit sent again). */
export function createRevisitFakeModel(seen: { extract: string[] } = { extract: [] }): MockModel {
  const typeOfHost = new Map<string, string>(Object.values(REVISIT_SOURCES).map((s) => [s.host, s.type]));
  return new MockModel(
    {
      "classify-document": (input) => ({
        doc_type: typeOfHost.get(new URL((input as ClassifyDocumentInput).url).hostname) ?? "travel_guide",
        languages: [],
        published_at: null,
        observed_at: null,
        observed_at_explicit: false,
        observed_at_reason: null,
        areas: [],
      }),
      "disambiguate-mention": () => ({ choice: 1, confidence: 0.9 }),
      "extract-facts": (input) => {
        const i = input as ExtractFactsInput;
        seen.extract.push(i.object.name);
        return { facts: revisitFacts(i) };
      },
      "extract-route": () => ({ stops: [] }),
      "summarize-profile": () => ({ text: "Eine ruhige Bucht im Testrevier. Der Ankergrund hält gut." }),
    },
    { batchIdPrefix: `mock-revisit-${newId()}-` },
  );
}
