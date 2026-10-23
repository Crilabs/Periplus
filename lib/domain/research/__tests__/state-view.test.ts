import { describe, expect, it } from "vitest";
import { berthStates } from "@/lib/db/schema";
import { berthStateView } from "@/lib/domain/research/view";
import { getConfig } from "@/lib/config";
import { insertPlace } from "@/test/consolidation";
import { seedPage, seedStatement } from "@/test/research-state";
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

  it("names the origin of a fact by the unit kind of the facts it stands for: berth page, landside page, none known", () =>
    withRollback(async (tx) => {
      const config = getConfig();
      const { placeId } = await insertPlace(tx, { name: "Vathi" });
      const berthPage = await seedPage(tx, config, placeId, { domain: "berth.example" });
      const landPage = await seedPage(tx, config, placeId, { kind: "landside" });
      const berthFact = await seedStatement(tx, placeId, berthPage, { statement: "Quiet at night" });
      const landFact = await seedStatement(tx, placeId, landPage, { statement: "Taverna by the beach", subjectName: "Taverna Kyma", subjectCategory: "restaurant" });
      const both = await seedStatement(tx, placeId, landPage, { statement: "Water at the quay", subjectName: "Quay", subjectCategory: "other" });
      const fact = (factId: string, over: object = {}) => ({ factId, subject: "berth" as const, subjectName: null, subjectCategory: null, statement: factId, observedAt: "2025-01-01", tone: null, safety: false, mentions: 1, ...over });
      await tx.insert(berthStates).values({
        placeId,
        core: {},
        gaps: [],
        facts: [fact(berthFact), fact(landFact), fact("not-a-uuid"), fact(both, { memberIds: [both, berthFact] })],
        landing: [],
        nearby: [],
      });
      const view = await berthStateView(tx, placeId);
      const origin = (id: string) => view!.facts.find((f) => f.factId === id)!.origin;
      expect(origin(berthFact)).toBe("berth");
      expect(origin(landFact)).toBe("landside");
      expect(origin("not-a-uuid")).toBeNull();
      expect(origin(both)).toBe("berth"); // a berth page among the members makes it a berth fact
    }));
});
