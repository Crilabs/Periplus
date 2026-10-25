import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { berthStates, geoObjects, poiCategoryEnum } from "@/lib/db/schema";
import { upsertGeoObject } from "@/lib/domain/gazetteer/store";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestRun } from "@/test/text";

describe("berth state schema", () => {
  it("stores core, gaps, facts, landing and nearby per place and keeps one row per place", () =>
    withRollback(async (tx: Db) => {
      const { placeId } = await insertPlace(tx);
      const runId = await insertTestRun(tx);
      await tx.insert(berthStates).values({
        placeId,
        core: { "shelter.N": { value: "good", confidence: 0.8, origin: "computed", observedAt: null, factIds: [] } },
        gaps: ["seabed"],
        facts: [{ factId: "f1", subject: "berth", subjectName: null, subjectCategory: null, statement: "s", observedAt: "2024-07-01", tone: "neutral", safety: false, mentions: 2 }],
        landing: [{ kind: "harbour", lon: 25.1, lat: 36.2, geoObjectId: null, description: null }],
        nearby: [{ geoObjectId: "g1", category: "food", distanceM: 120, access: "foot" }],
        runId,
      });
      const [row] = await tx.select().from(berthStates).where(eq(berthStates.placeId, placeId));
      expect(row!.gaps).toEqual(["seabed"]);
      expect(row!.core["shelter.N"]!.origin).toBe("computed");
      expect(row!.facts[0]!.mentions).toBe(2);
      expect(row!.landing[0]!.kind).toBe("harbour");
      expect(row!.nearby[0]!.access).toBe("foot");
      expect(row!.updatedAt).toBeInstanceOf(Date);
      await expect(tx.transaction((sp) => sp.insert(berthStates).values({ placeId, core: {}, gaps: [], facts: [], landing: [], nearby: [], runId }))).rejects.toThrow();
    }));

  it("knows the landside POI categories", () => {
    expect(poiCategoryEnum.enumValues).toEqual(expect.arrayContaining(["bakery", "transport", "landing"]));
  });

  it("stores a landing object as a poi", () =>
    withRollback(async (tx: Db) => {
      const r = await upsertGeoObject(tx, { type: "poi", origin: "osm", osmId: "node/1", category: "landing", geometry: { type: "Point", coordinates: [25.1, 36.2] }, names: [] });
      if ("skipped" in r) throw new Error(r.skipped);
      const [o] = await tx.select({ c: geoObjects.category }).from(geoObjects).where(eq(geoObjects.id, r.id));
      expect(o!.c).toBe("landing");
    }));
});
