import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { ExtractBerthInput, ExtractBerthOutput } from "@/lib/ai/tasks/extract-berth";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { berthFacts, berthSignals, landingHints, researchUnits } from "@/lib/db/schema";
import type { DroppedCounts } from "@/lib/db/schema/research-extract";
import type { ObservedAtBasis } from "@/lib/db/schema/sources";
import { nameInQuote } from "@/lib/domain/extraction/facts";
import { locateQuote } from "@/lib/domain/extraction/quote";
import { getFactSchema, SAFETY_LIST_ATTRIBUTES, validateTextFact } from "@/lib/domain/facts/schema";
import { plausibleDate } from "@/lib/domain/mentions/classification";
import { copiesSource } from "./verbatim";

/*
 * Stores what the model extracted from one research unit (plan N2). Every element must carry a quote that
 * `locateQuote` finds in the unit text (the text the model saw), else it is dropped (`dropped.quote`); a core value
 * must fit its v4 attribute (`dropped.value`); a statement or landing description must not copy
 * `research.extraction.maxSharedWords` consecutive words of the unit text (`dropped.verbatim`). Quote positions are
 * stored as indexes in the page's Markdown (through the unit's offset map). Each element is dated by its own
 * `observed_at` when that is a plausible date (a month becomes day 15), else by the page's observation date.
 */

const MAX_TEXT_CHARS = 500;
const MAX_SUBJECT_CHARS = 120;

/** The text attributes of the fact schema's place level, as the extraction prompt lists them. */
export function berthAttributes(version: string): ExtractBerthInput["attributes"] {
  return getFactSchema(version)
    .levels.place.filter((d) => d.origins.includes("text"))
    .map((d) => {
      const format: Record<string, unknown> = z.toJSONSchema(d.textValue ?? d.value, { unrepresentable: "any" });
      delete format.$schema;
      return { key: d.key, description: d.textDescription ?? d.description, values: JSON.stringify(format) };
    });
}

export type ExtractionUnit = {
  id: string;
  placeId: string;
  documentVersionId: string;
  /** The unit text the model saw. */
  text: string;
  /** Unit text index → Markdown index (`unitText`); `null`: the unit text is the whole Markdown. */
  offset: number[] | null;
  observedAt: string;
  observedAtBasis: ObservedAtBasis;
  fetchedAt: Date;
};

export type ExtractionStats = { facts: number; signals: number; landing: number; dropped: DroppedCounts };

/** A core value as delivered: JSON text, else the bare word itself (`good` for `"good"`). */
function parseValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const trimmed = (s: string | null, max: number): string | null => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t.slice(0, max);
};

/**
 * Stores the verified elements of one unit's answer and marks the unit `done` with its drop counters, in the caller's
 * transaction. Returns what was stored and what was dropped.
 */
export async function storeExtraction(db: Db, unit: ExtractionUnit, out: ExtractBerthOutput, cfg: AppConfig): Promise<ExtractionStats> {
  const dropped: DroppedCounts = { quote: 0, value: 0, verbatim: 0 };
  const { factSchema, maxSharedWords } = cfg.research.extraction;
  const earliest = cfg.extraction.earliestDate;

  /** Markdown range of a quote of the unit text, or null when it is not there. */
  const locate = (quote: string): { quote: string; quoteStart: number; quoteEnd: number } | null => {
    const found = locateQuote(unit.text, quote, cfg.extraction.quote);
    if (!found.ok) return null;
    if (unit.offset === null) return { quote, quoteStart: found.start, quoteEnd: found.end };
    const start = unit.offset[found.start];
    const last = unit.offset[found.end - 1];
    if (start === undefined || last === undefined || start < 0 || last < start) return null;
    return { quote, quoteStart: start, quoteEnd: last + 1 };
  };
  const dated = (value: string | null): { observedAt: string; observedAtBasis: ObservedAtBasis } => {
    const own = plausibleDate(value, unit.fetchedAt, earliest, true);
    return own ? { observedAt: own, observedAtBasis: "explicit" } : { observedAt: unit.observedAt, observedAtBasis: unit.observedAtBasis };
  };
  const owner = { unitId: unit.id, placeId: unit.placeId, documentVersionId: unit.documentVersionId };

  const factRows: Array<typeof berthFacts.$inferInsert> = [];
  const schema = getFactSchema(factSchema);
  for (const c of out.core) {
    const at = locate(c.quote);
    if (!at) {
      dropped.quote++;
      continue;
    }
    const checked = validateTextFact("place", c.attribute, parseValue(c.value), factSchema);
    if (!checked.ok) {
      dropped.value++;
      continue;
    }
    // Proper names inside a value (hazard names …) count only when the quote contains them.
    let value = checked.value;
    const textNames = schema.levels.place.find((d) => d.key === c.attribute)?.textNames;
    if (textNames) {
      const supported = textNames(value, (name) => nameInQuote(name, c.quote));
      if (supported.value === null) {
        dropped.value++;
        continue;
      }
      value = supported.value;
    }
    factRows.push({
      ...owner,
      ...at,
      ...dated(null),
      attribute: c.attribute,
      value,
      safety: (SAFETY_LIST_ATTRIBUTES as readonly string[]).includes(c.attribute),
    });
  }

  for (const f of out.facts) {
    const at = locate(f.quote);
    if (!at) {
      dropped.quote++;
      continue;
    }
    const statement = trimmed(f.statement, MAX_TEXT_CHARS);
    if (!statement) {
      dropped.value++;
      continue;
    }
    if (copiesSource(statement, unit.text, maxSharedWords)) {
      dropped.verbatim++;
      continue;
    }
    const landside = f.about === "landside";
    factRows.push({
      ...owner,
      ...at,
      ...dated(f.observed_at),
      statement,
      subjectName: landside ? trimmed(f.subject_name, MAX_SUBJECT_CHARS) : null,
      subjectCategory: landside ? trimmed(f.subject_category, MAX_SUBJECT_CHARS) : null,
      tone: f.tone,
      safety: f.safety,
    });
  }

  const signalRows: Array<typeof berthSignals.$inferInsert> = [];
  for (const s of out.signals) {
    const at = locate(s.quote);
    if (!at) {
      dropped.quote++;
      continue;
    }
    if (!Number.isFinite(s.confidence)) {
      dropped.value++;
      continue;
    }
    signalRows.push({ ...owner, ...at, ...dated(s.observed_at), kind: s.kind, firstHand: s.first_hand, confidence: clamp01(s.confidence) });
  }

  const landingRows: Array<typeof landingHints.$inferInsert> = [];
  for (const l of out.landing) {
    const at = locate(l.quote);
    if (!at) {
      dropped.quote++;
      continue;
    }
    const description = trimmed(l.description, MAX_TEXT_CHARS);
    if (!description) {
      dropped.value++;
      continue;
    }
    if (copiesSource(description, unit.text, maxSharedWords)) {
      dropped.verbatim++;
      continue;
    }
    landingRows.push({ ...owner, ...at, observedAt: unit.observedAt, description });
  }

  if (factRows.length > 0) await db.insert(berthFacts).values(factRows);
  if (signalRows.length > 0) await db.insert(berthSignals).values(signalRows);
  if (landingRows.length > 0) await db.insert(landingHints).values(landingRows);
  await db
    .update(researchUnits)
    .set({ status: "done", reason: null, dropped })
    .where(and(eq(researchUnits.id, unit.id), ne(researchUnits.status, "done")));
  return { facts: factRows.length, signals: signalRows.length, landing: landingRows.length, dropped };
}
