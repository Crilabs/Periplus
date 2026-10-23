import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { berthFacts, berthSignals, researchUnits } from "@/lib/db/schema";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestRun, insertTestVersion } from "@/test/text";

async function rejectionMessage(tx: Db, run: (tx: Db) => Promise<unknown>): Promise<string> {
  try {
    await tx.transaction(async (sp) => {
      await run(sp);
    });
  } catch (e) {
    const err = e as Error;
    return `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`;
  }
  throw new Error("expected promise to reject");
}

async function seed(tx: Db) {
  const { placeId } = await insertPlace(tx);
  const runId = await insertTestRun(tx);
  const { versionId } = await insertTestVersion(tx, ["Text."]);
  const [unit] = await tx
    .insert(researchUnits)
    .values({ documentVersionId: versionId, placeId, model: "m", promptVersion: 1, status: "done", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 0 }, runId })
    .returning({ id: researchUnits.id });
  return { placeId, runId, versionId, unitId: unit!.id };
}

describe("research extract schema", () => {
  it("allows one unit per version, place, model and prompt version", () =>
    withRollback(async (tx) => {
      const s = await seed(tx);
      const again = () =>
        tx.insert(researchUnits).values({ documentVersionId: s.versionId, placeId: s.placeId, model: "m", promptVersion: 1, status: "pending", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 0 } });
      expect(await rejectionMessage(tx, again)).toContain("research_units_version_place_model_prompt_unique");
    }));

  const fact = (s: Awaited<ReturnType<typeof seed>>, extra: object) => ({
    unitId: s.unitId,
    placeId: s.placeId,
    documentVersionId: s.versionId,
    quote: "q",
    quoteStart: 0,
    quoteEnd: 1,
    observedAt: "2024-07-01",
    observedAtBasis: "explicit" as const,
    ...extra,
  });

  it("berth_facts needs exactly an attribute with a value, or a statement", () =>
    withRollback(async (tx) => {
      const s = await seed(tx);
      await tx.insert(berthFacts).values(fact(s, { attribute: "holding", value: "good" }));
      await tx.insert(berthFacts).values(fact(s, { statement: "Calm in the morning." }));
      for (const extra of [{ attribute: "holding", value: "good", statement: "x" }, {}, { attribute: "holding" }, { value: "good" }]) {
        expect(await rejectionMessage(tx, (t) => t.insert(berthFacts).values(fact(s, extra)))).toContain("berth_facts_shape_check");
      }
    }));

  it("berth_signals confidence stays within 0 and 1", () =>
    withRollback(async (tx) => {
      const s = await seed(tx);
      const sig = (confidence: number) => ({
        unitId: s.unitId,
        placeId: s.placeId,
        documentVersionId: s.versionId,
        kind: "anchored" as const,
        firstHand: true,
        confidence,
        quote: "q",
        quoteStart: 0,
        quoteEnd: 1,
        observedAt: "2024-07-01",
        observedAtBasis: "explicit" as const,
      });
      await tx.insert(berthSignals).values(sig(0.9));
      expect(await rejectionMessage(tx, (t) => t.insert(berthSignals).values(sig(1.2)))).toContain("berth_signals_confidence_check");
    }));
});
