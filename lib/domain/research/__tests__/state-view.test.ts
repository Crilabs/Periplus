import { describe, expect, it } from "vitest";
import { berthStates } from "@/lib/db/schema";
import { berthStateView } from "@/lib/domain/research/view";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";

describe("berthStateView", () => {
  it("is null without a state and formats the stored state with names and labels", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx, { name: "Vathi" });
      const poi = await insertPlace(tx, { name: "Kafeneio", type: "poi" });
      expect(await berthStateView(tx, placeId)).toBeNull();
      await tx.insert(berthStates).values({
        placeId,
        core: { holding: { value: "good", confidence: 0.8, origin: "text", observedAt: "2025-06-15", factIds: [] } },
        gaps: ["seabed"],
        facts: [
          { factId: "a", subject: "berth", subjectName: null, subjectCategory: null, statement: "old", observedAt: "2020-01-01", tone: null, safety: false, mentions: 1 },
          { factId: "b", subject: "berth", subjectName: null, subjectCategory: null, statement: "new", observedAt: "2025-01-01", tone: null, safety: false, mentions: 1 },
        ],
        landing: [],
        nearby: [{ geoObjectId: poi.objectId, category: "food", distanceM: 200, access: "foot" }],
      });
      const view = await berthStateView(tx, placeId);
      expect(view).toMatchObject({ status: "confirmed" });
      expect(view!.core).toEqual([expect.objectContaining({ attribute: "holding", origin: "text", label: expect.any(String), value: expect.any(String) })]);
      expect(view!.gaps.map((g) => g.attribute)).toEqual(["seabed"]);
      expect(view!.facts.map((f) => f.factId)).toEqual(["b", "a"]); // newest first
      expect(view!.nearby).toEqual([expect.objectContaining({ name: "Kafeneio", categoryLabel: "Essen", access: "foot" })]);
    }));
});
