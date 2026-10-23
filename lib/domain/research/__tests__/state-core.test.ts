import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { berthFacts, documents, pageAssessments, researchUnits, type PageKind } from "@/lib/db/schema";
import type { ConsolidationInput } from "@/lib/domain/consolidation/types";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { activeExtractor } from "@/lib/domain/research/confirmation";
import { coreInputs, decideCore } from "@/lib/domain/research/state-core";
import { getFactSchema } from "@/lib/domain/facts/schema";
import { newId } from "@/lib/domain/ids";
import { insertComputation, insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestRun, insertTestVersion } from "@/test/text";

/*
 * Core values of a berth state (plan N4a task 2): computed facts of the geo object plus checked text facts of the
 * active extraction, decided per v4 attribute by the consolidation rules.
 */

const config = getConfig();
const TODAY = "2026-10-23";
const anchorage = { kind: "anchorage" as const, status: "confirmed" as const };
const V4_KEYS = getFactSchema(config.research.extraction.factSchema).levels.place.map((d) => d.key);

let seq = 0;
function input(o: Partial<ConsolidationInput>): ConsolidationInput {
  seq += 1;
  const text = (o.origin ?? "text") === "text";
  return {
    factId: `f${seq}`,
    attribute: "holding",
    value: "good",
    origin: "text",
    confidence: 0.8,
    observedAt: "2025-06-15",
    dateKnown: true,
    sourceKey: text ? `sail-${seq}.example` : "computed:shelter",
    sourceWeight: text ? 0.6 : 1,
    sourceType: text ? "trip_report" : null,
    documentId: text ? `d${seq}` : null,
    gone: false,
    lastConfirmedAt: o.observedAt ?? "2025-06-15",
    computationId: text ? null : `c${seq}`,
    poiId: null,
    ...o,
  };
}
const computed = (attribute: string, value: unknown) =>
  input({ attribute, value, origin: "computed", confidence: 0.55, observedAt: "2026-10-01", lastConfirmedAt: "2026-10-01" });

describe("decideCore", () => {
  it("shelter: the computation is the basis, a text corrects it by at most one step", () => {
    const basis = computed("shelter.N", 0.9);
    const poor = input({ attribute: "shelter.N", value: 0.1 });
    const { core } = decideCore([basis, poor], anchorage, config, TODAY);
    expect(core["shelter.N"]).toMatchObject({ value: 0.6, origin: "text", factIds: [poor.factId] });

    const up = decideCore([computed("shelter.S", 0.5), input({ attribute: "shelter.S", value: 0.9 })], anchorage, config, TODAY);
    expect(up.core["shelter.S"]).toMatchObject({ value: 0.8, origin: "text" });

    const alone = decideCore([basis], anchorage, config, TODAY);
    expect(alone.core["shelter.N"]).toMatchObject({ value: 0.9, origin: "computed", observedAt: "2026-10-01", factIds: [basis.factId] });
  });

  it("holding comes from text only", () => {
    const fromComputation = decideCore([computed("holding", "good")], anchorage, config, TODAY);
    expect(fromComputation.core.holding).toBeUndefined();
    expect(fromComputation.gaps).toContain("holding");

    const text = input({ attribute: "holding", value: "moderate" });
    const { core, gaps } = decideCore([text], anchorage, config, TODAY);
    expect(core.holding).toMatchObject({ value: "moderate", origin: "text", confidence: expect.any(Number), factIds: [text.factId] });
    expect(gaps).not.toContain("holding");
  });

  it("prices: the youngest observation holds", () => {
    const old = input({ attribute: "prices", value: { amount: 20, currency: "EUR", unit: "night" }, observedAt: "2022-07-01", sourceWeight: 0.8 });
    const young = input({ attribute: "prices", value: { amount: 35, currency: "EUR", unit: "night" }, observedAt: "2025-07-01" });
    const { core } = decideCore([old, young], anchorage, config, TODAY);
    expect(core.prices).toMatchObject({ value: { amount: 35, currency: "EUR", unit: "night" }, origin: "text", observedAt: "2025-07-01", factIds: [young.factId] });
  });

  it("a berth without any text fact keeps its computed values and lists every other v4 attribute as a gap (Review Focus)", () => {
    const inputs = [computed("shelter.N", 0.7), computed("depth.min", 4)];
    const { core, gaps } = decideCore(inputs, anchorage, config, TODAY);
    expect(Object.keys(core).sort()).toEqual(["depth.min", "shelter.N"]);
    expect(Object.values(core).every((v) => v.origin === "computed")).toBe(true);
    expect(gaps).toEqual(V4_KEYS.filter((k) => k !== "shelter.N" && k !== "depth.min"));
  });

  it("ignores inputs of attributes outside v4", () => {
    const { core } = decideCore([computed("fetch.N", 3000)], anchorage, config, TODAY);
    expect(core["fetch.N"]).toBeUndefined();
  });
});

/** A page of `domain` with an active assessment of `pageKind` and a unit of `model` with `status`. */
async function page(tx: Db, placeId: string, o: { domain: string; pageKind?: PageKind; model?: string; status?: "done" | "failed"; gone?: boolean }) {
  const { model, promptVersion } = activeAssessor(config);
  const ex = activeExtractor(config);
  const url = `https://www.${o.domain}/${newId()}`;
  const { sourceId } = await insertTestVersion(tx, ["y"]);
  const [doc] = await tx
    .insert(documents)
    .values({ sourceId, url, urlNormalized: url, docType: "trip_report", status: o.gone ? "gone" : "active" })
    .returning({ id: documents.id });
  const v = await insertTestVersion(tx, ["x"], { documentId: doc!.id });
  await tx.insert(pageAssessments).values({
    documentVersionId: v.versionId, model, promptVersion, pageKind: o.pageKind ?? "trip_report", firstHand: true, generated: false,
    observedAt: "2025-06-15", observedAtBasis: "explicit", berths: [], runId: await insertTestRun(tx),
  });
  const [u] = await tx
    .insert(researchUnits)
    .values({ documentVersionId: v.versionId, placeId, model: o.model ?? ex.model, promptVersion: ex.promptVersion, status: o.status ?? "done", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 0 } })
    .returning({ id: researchUnits.id });
  return { unitId: u!.id, versionId: v.versionId, documentId: doc!.id };
}

async function fact(
  tx: Db,
  placeId: string,
  p: { unitId: string; versionId: string },
  o: { attribute?: string; value?: unknown; statement?: string; observedAt?: string; basis?: "explicit" | "published" | "fetched" },
) {
  const [f] = await tx
    .insert(berthFacts)
    .values({
      unitId: p.unitId, placeId, documentVersionId: p.versionId,
      attribute: o.statement ? null : (o.attribute ?? "holding"), value: o.statement ? null : (o.value ?? "good"), statement: o.statement ?? null,
      quote: "good holding", quoteStart: 0, quoteEnd: 12, observedAt: o.observedAt ?? "2025-06-15", observedAtBasis: o.basis ?? "explicit",
    })
    .returning({ id: berthFacts.id });
  return f!.id;
}

describe("coreInputs", () => {
  it("reads the newest computation and the structured text facts of done units of the active extractor", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx);
      const { computationId, factIds } = await insertComputation(tx, objectId, "shelter", { "shelter.N": 0.8 });
      const guide = await page(tx, placeId, { domain: "guide.example", pageKind: "pilot_guide" });
      const list = await page(tx, placeId, { domain: "list.example", pageKind: "listing", gone: true });
      const stale = await page(tx, placeId, { domain: "old.example", model: "old-model" });
      const failed = await page(tx, placeId, { domain: "fail.example", status: "failed" });
      const holding = await fact(tx, placeId, guide, { attribute: "holding", value: "good", observedAt: "2024-05-15", basis: "explicit" });
      const prices = await fact(tx, placeId, list, { attribute: "prices", value: { amount: 30, currency: "EUR", unit: "night" }, observedAt: "2026-10-19", basis: "fetched" });
      await fact(tx, placeId, guide, { statement: "Nice taverna on the beach" });
      await fact(tx, placeId, stale, { attribute: "holding", value: "poor" });
      await fact(tx, placeId, failed, { attribute: "holding", value: "poor" });

      const inputs = await coreInputs(tx, placeId, config);
      expect(inputs.map((i) => i.factId).sort()).toEqual([factIds[0], holding, prices].sort());
      expect(inputs.find((i) => i.factId === factIds[0])).toMatchObject({ origin: "computed", attribute: "shelter.N", value: 0.8, computationId });
      expect(inputs.find((i) => i.factId === holding)).toMatchObject({
        origin: "text", attribute: "holding", value: "good", confidence: 0.8, observedAt: "2024-05-15", dateKnown: true,
        sourceKey: "guide.example", sourceWeight: config.sourceTypes.pilot_guide.weight, sourceType: "pilot_guide",
        documentId: guide.documentId, gone: false, lastConfirmedAt: "2024-05-15", computationId: null, poiId: null,
      });
      // a listing counts as `other`; a fetch date is no observation date; a gone document is marked gone
      expect(inputs.find((i) => i.factId === prices)).toMatchObject({
        sourceKey: "list.example", sourceWeight: config.sourceTypes.other.weight, sourceType: "other", dateKnown: false, gone: true,
      });
    }));

  it("a place without text facts yields only its computed inputs", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx);
      await insertComputation(tx, objectId, "shelter", { "shelter.N": 0.8, "shelter.S": 0.4 });
      const inputs = await coreInputs(tx, placeId, config);
      expect(inputs.map((i) => [i.attribute, i.origin])).toEqual([["shelter.N", "computed"], ["shelter.S", "computed"]]);
    }));
});
