import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geoObjects, sources } from "@/lib/db/schema";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { endSource, getSource, resumeSource } from "@/lib/domain/sources/store";
import { latestProfile } from "@/lib/domain/timeline";
import { insertPlace, insertSource, insertTextFact } from "@/test/consolidation";
import { withRollback } from "@/test/db";

/*
 * „Quelle beenden“ (ruling M6-H-R1), the remedy of a package blocked by `foreign_content`: the source ends, its facts
 * stop counting, and the objects to consolidate again are named. withRollback on the synthetic grid around 21.0/35.2.
 */

async function utcToday(tx: Db): Promise<string> {
  const { rows } = await tx.execute<{ d: string }>(sql`select (now() at time zone 'UTC')::date::text as d`);
  return rows[0]!.d;
}

async function approvedSource(tx: Db): Promise<string> {
  const id = await insertSource(tx, "forum", 0.4);
  await tx.update(sources).set({ status: "approved" }).where(eq(sources.id, id));
  return id;
}

describe("endSource", () => {
  it("ends an approved source today and names its objects, a merged one by its final target", () =>
    withRollback(async (tx) => {
      const sourceId = await approvedSource(tx);
      const a = await insertPlace(tx, { name: "Endbucht" });
      const dropped = await insertPlace(tx, { name: "Alte Bucht", lon: 21.01 });
      const keep = await insertPlace(tx, { name: "Neue Bucht", lon: 21.02 });
      const untouched = await insertPlace(tx, { name: "Andere Bucht", lon: 21.03 });
      await insertTextFact(tx, a.objectId, sourceId, { attribute: "holding", value: "good", observedAt: "2026-07-01" });
      await insertTextFact(tx, dropped.objectId, sourceId, { attribute: "holding", value: "poor", observedAt: "2026-07-01" });
      await insertTextFact(tx, untouched.objectId, await approvedSource(tx), { attribute: "holding", value: "good", observedAt: "2026-07-01" });
      await tx.update(geoObjects).set({ mergedIntoId: keep.objectId }).where(eq(geoObjects.id, dropped.objectId));

      const result = await endSource(tx, sourceId);
      expect(result).toEqual({ ended: true, geoObjectIds: [a.objectId, keep.objectId].sort() });
      const source = await getSource(tx, sourceId);
      expect(source).toMatchObject({ status: "approved", validTo: await utcToday(tx) });
      // ended for good: neither ended again nor resumed
      expect(await endSource(tx, sourceId)).toEqual({ ended: false, geoObjectIds: [] });
      expect(await resumeSource(tx, sourceId)).toBe(false);
    }));

  it("a paused source ends too; a proposed or rejected one does not", () =>
    withRollback(async (tx) => {
      const paused = await approvedSource(tx);
      await tx.update(sources).set({ status: "paused" }).where(eq(sources.id, paused));
      expect((await endSource(tx, paused)).ended).toBe(true);
      for (const status of ["proposed", "rejected"] as const) {
        const id = await insertSource(tx);
        await tx.update(sources).set({ status }).where(eq(sources.id, id));
        expect(await endSource(tx, id)).toEqual({ ended: false, geoObjectIds: [] });
        expect((await getSource(tx, id))!.validTo).toBeNull();
      }
    }));

  it("the next consolidation leaves the ended source's values out", () =>
    withRollback(async (tx) => {
      const sourceId = await approvedSource(tx);
      const { objectId } = await insertPlace(tx, { name: "Navilybucht" });
      await insertTextFact(tx, objectId, sourceId, { attribute: "holding", value: "good", observedAt: "2026-07-01" });
      const today = await utcToday(tx);
      await consolidateGeo(tx, objectId, { today });
      expect((await latestProfile(tx, objectId))!.attributes["holding"]).toBe("good");
      await endSource(tx, sourceId);
      await consolidateGeo(tx, objectId, { today });
      expect((await latestProfile(tx, objectId))!.attributes["holding"]).toBeUndefined();
    }));
});
