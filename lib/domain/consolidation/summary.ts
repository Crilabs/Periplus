import type { SummarizeInput } from "@/lib/ai/tasks/summarize-profile";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { findArchiveCopies } from "@/lib/domain/documents/archive-copies";
import { formatProfileValue, profileAttributeLabel } from "./format";
import type { ProfileSnapshot } from "./types";

/*
 * The input and the check of a profile summary (spec 07 `summary.de`: "zwei bis vier Sätze … ausschließlich aus dem
 * konsolidierten Profil (Werte, keine Zitate)"; a 15-word hit in the archive → generated again). Calling the model and
 * storing the result is the stage `consolidation.summary` (`lib/pipeline/consolidation/summary.ts`).
 */

/** Profile keys that never go into a summary: technical derived values without meaning for a reader. */
const LEFT_OUT = new Set(["derived.spot_ids", "derived.radius_nm"]);

/**
 * What the model gets for one profile version: per value its German label and formatted value (`formatProfileValue`),
 * in the profile's key order. Left out: identity fields (rule `identity`: name, parent, geometry, place kind, status,
 * position; `exclude` only when the place is not excluded) and the gap list (attributes without a value are absent),
 * so no quote, id or source text can reach the prompt. `lowConfidence` when the profile confidence is below
 * `summary.lowConfidence` (or unknown); `avoid` false (the first attempt).
 */
export function summaryInput(
  snapshot: Pick<ProfileSnapshot, "attributes" | "provenance" | "confidence">,
  ctx: { level: "place" | "poi"; name: string; cfg: ConsolidationConfig },
): SummarizeInput {
  const facts: SummarizeInput["facts"] = [];
  for (const [key, value] of Object.entries(snapshot.attributes)) {
    if (value === null || value === undefined || LEFT_OUT.has(key)) continue;
    const identity = snapshot.provenance[key]?.rule === "identity";
    if (identity && !(key === "exclude" && (value as { excluded?: unknown }).excluded === true)) continue;
    facts.push({ label: profileAttributeLabel(key), value: formatProfileValue(key, value) });
  }
  return {
    kind: ctx.level === "place" ? "spot" : "highlight",
    name: ctx.name,
    sentences: ctx.cfg.summary.sentences[ctx.level],
    lowConfidence: snapshot.confidence === null || snapshot.confidence < ctx.cfg.summary.lowConfidence,
    facts,
    avoid: false,
  };
}

/**
 * Sentences of a text: runs ending in `.`, `!`, `?` or `…` that are followed by an upper-case start or the end, plus a
 * last sentence without a full stop. Numbers ("0,62", "4 m") and lower-case continuations ("ca. 4 m") do not split.
 */
export function sentenceCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const ends = trimmed.match(/[.!?…]+(?=\s+[A-ZÄÖÜ„"(]|\s*$)/g)?.length ?? 0;
  return /[.!?…]\s*$/.test(trimmed) ? ends : ends + 1;
}

/**
 * Whether a summary may be stored: `copied` when a run of 15 words of it stands in the archive (`findArchiveCopies`),
 * `sentences` when its sentence count lies outside `range`, else `ok`.
 */
export async function checkSummary(db: Db, text: string, range: [number, number]): Promise<"ok" | "copied" | "sentences"> {
  if ((await findArchiveCopies(db, text)).hits > 0) return "copied";
  const n = sentenceCount(text);
  return n < range[0] || n > range[1] ? "sentences" : "ok";
}
