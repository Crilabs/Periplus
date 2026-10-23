import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ExtractBerthOutput } from "@/lib/ai/tasks/extract-berth";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { berthFacts, berthSignals, landingHints, researchUnits } from "@/lib/db/schema";
import { berthAttributes, storeExtraction } from "@/lib/domain/research/extraction";
import { expandOffsetRuns, offsetRuns, unitText } from "@/lib/domain/research/unit-text";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestVersion } from "@/test/text";

const cfg = getConfig();
const fetchedAt = new Date("2026-10-19T10:00:00Z");

const PAGE = [
  "# Ormos Vathi",
  "We anchored in Vathi in June 2024 on sand in 6 m, the holding was good and the bay was calm overnight.",
  "Taverna Nikos at the beach serves fresh fish and lets yachts use its dinghy jetty.",
].join("\n\n");

const empty = (): ExtractBerthOutput => ({ core: [], facts: [], signals: [], landing: [] });

async function unitOf(tx: Db, text = PAGE, offset: number[] | null = null) {
  const place = await insertPlace(tx, { name: "Vathi", lon: 30.1, lat: 40.1, status: "candidate" });
  const v = await insertTestVersion(tx, ["x"]);
  const [row] = await tx
    .insert(researchUnits)
    .values({ documentVersionId: v.versionId, placeId: place.placeId, model: "claude-sonnet-5-5", promptVersion: 1, status: "pending", dropped: { quote: 0, value: 0, verbatim: 0 } })
    .returning({ id: researchUnits.id });
  return {
    id: row!.id,
    placeId: place.placeId,
    documentVersionId: v.versionId,
    text,
    offset,
    observedAt: "2025-05-15",
    observedAtBasis: "published" as const,
    fetchedAt,
  };
}

describe("berthAttributes", () => {
  it("lists the text attributes of v4 with description and value format", () => {
    const attrs = berthAttributes("v4");
    const holding = attrs.find((a) => a.key === "holding");
    expect(holding?.values).toContain("good");
    expect(attrs.every((a) => a.description.length > 0)).toBe(true);
  });
});

describe("offset runs", () => {
  it("round-trip the offset map of a windowed unit text", () => {
    const md = Array.from({ length: 400 }, (_, i) => (i === 50 || i === 300 ? "Vathi" : `w${i}`)).join(" ");
    const { offset } = unitText(md, ["Vathi"], { maxUnitWords: 100, windowWords: 10 });
    expect(offset).not.toBeNull();
    expect(expandOffsetRuns(offsetRuns(offset))).toEqual(offset);
    expect(offsetRuns(null)).toBeNull();
    expect(expandOffsetRuns(null)).toBeNull();
  });
});

describe("storeExtraction", () => {
  it("drops an invented quote", () =>
    withRollback(async (tx) => {
      const unit = await unitOf(tx);
      const out = empty();
      out.signals.push({ kind: "anchored", first_hand: true, confidence: 0.9, quote: "We dropped the hook in Vathi under the cliffs", observed_at: null });
      const result = await storeExtraction(tx, unit, out, cfg);
      expect(result).toEqual({ facts: 0, signals: 0, landing: 0, dropped: { quote: 1, value: 0, verbatim: 0 } });
      expect(await tx.select().from(berthSignals).where(eq(berthSignals.unitId, unit.id))).toHaveLength(0);
      const [row] = await tx.select().from(researchUnits).where(eq(researchUnits.id, unit.id));
      expect(row).toMatchObject({ status: "done", dropped: { quote: 1, value: 0, verbatim: 0 } });
    }));

  it("drops a core value outside the attribute's schema and keeps a valid one", () =>
    withRollback(async (tx) => {
      const unit = await unitOf(tx);
      const out = empty();
      out.core.push({ attribute: "holding", value: "excellent", quote: "the holding was good" });
      out.core.push({ attribute: "holding", value: '"good"', quote: "the holding was good" });
      out.core.push({ attribute: "no_such_key", value: "1", quote: "the holding was good" });
      const result = await storeExtraction(tx, unit, out, cfg);
      expect(result.dropped).toEqual({ quote: 0, value: 2, verbatim: 0 });
      const rows = await tx.select().from(berthFacts).where(eq(berthFacts.unitId, unit.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ attribute: "holding", value: "good", statement: null, observedAt: "2025-05-15", observedAtBasis: "published" });
    }));

  it("drops a statement that copies the page", () =>
    withRollback(async (tx) => {
      const unit = await unitOf(tx);
      const out = empty();
      out.facts.push({
        about: "berth",
        subject_name: null,
        subject_category: null,
        // nine consecutive words of the page
        statement: "Reports say the holding was good and the bay was calm.",
        quote: "the holding was good and the bay was calm overnight",
        observed_at: null,
        tone: "positive",
        safety: false,
      });
      const result = await storeExtraction(tx, unit, out, cfg);
      expect(result).toMatchObject({ facts: 0, dropped: { quote: 0, value: 0, verbatim: 1 } });
    }));

  it("stores a landside fact with its subject", () =>
    withRollback(async (tx) => {
      const unit = await unitOf(tx);
      const out = empty();
      out.facts.push({
        about: "landside",
        subject_name: "Taverna Nikos",
        subject_category: "restaurant",
        statement: "A beach taverna offers fish and a jetty for tenders.",
        quote: "Taverna Nikos at the beach serves fresh fish",
        observed_at: null,
        tone: "positive",
        safety: false,
      });
      const result = await storeExtraction(tx, unit, out, cfg);
      expect(result.facts).toBe(1);
      const [row] = await tx.select().from(berthFacts).where(eq(berthFacts.unitId, unit.id));
      expect(row).toMatchObject({ subjectName: "Taverna Nikos", subjectCategory: "restaurant", attribute: null, tone: "positive", safety: false });
      expect(PAGE.slice(row!.quoteStart, row!.quoteEnd)).toBe("Taverna Nikos at the beach serves fresh fish");
    }));

  it("dates a first-hand signal by its own month", () =>
    withRollback(async (tx) => {
      const unit = await unitOf(tx);
      const out = empty();
      out.signals.push({ kind: "anchored", first_hand: true, confidence: 0.9, quote: "We anchored in Vathi in June 2024", observed_at: "2024-06" });
      out.landing.push({ description: "Tenders can land at the taverna's jetty.", quote: "lets yachts use its dinghy jetty" });
      const result = await storeExtraction(tx, unit, out, cfg);
      expect(result).toMatchObject({ signals: 1, landing: 1 });
      const [signal] = await tx.select().from(berthSignals).where(eq(berthSignals.unitId, unit.id));
      expect(signal).toMatchObject({ kind: "anchored", firstHand: true, observedAt: "2024-06-15", observedAtBasis: "explicit", placeId: unit.placeId });
      const [hint] = await tx.select().from(landingHints).where(eq(landingHints.unitId, unit.id));
      expect(hint).toMatchObject({ observedAt: "2025-05-15", description: "Tenders can land at the taverna's jetty." });
    }));

  it("maps a quote of a window of a long page into the original markdown", () =>
    withRollback(async (tx) => {
      const filler = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(" ");
      const md = `${filler(300, "a")}\n\nAt Vathi we picked up a mooring buoy for the night.\n\n${filler(300, "b")}`;
      const { text, offset } = unitText(md, ["Vathi"], { maxUnitWords: 100, windowWords: 20 });
      expect(offset).not.toBeNull();
      expect(text.length).toBeLessThan(md.length);
      const unit = await unitOf(tx, text, offset);
      const out = empty();
      out.signals.push({ kind: "moored_buoy", first_hand: true, confidence: 0.8, quote: "we picked up a mooring buoy for the night", observed_at: null });
      await storeExtraction(tx, unit, out, cfg);
      const [signal] = await tx.select().from(berthSignals).where(eq(berthSignals.unitId, unit.id));
      expect(signal!.quoteStart).toBe(md.indexOf("we picked up"));
      expect(md.slice(signal!.quoteStart, signal!.quoteEnd)).toBe("we picked up a mooring buoy for the night");
    }));
});
