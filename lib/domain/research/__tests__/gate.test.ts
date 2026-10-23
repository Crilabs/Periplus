import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, places, reviewDecisions } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { setPlaceStatusByAdmin } from "@/lib/domain/place-status";
import { verdictsByThreshold } from "@/lib/domain/research/gate";
import { placeOf } from "@/test/confirmation";
import { withRollback } from "@/test/db";
import { signalPage } from "@/test/research-signals";
import { insertTestSubdivision } from "@/test/text";

/* The verdicts per confirmation threshold (plan N3 task 1) against real Postgres; nothing is written. */

const config: AppConfig = loadConfig("config");

/** A place of the subdivision `key`, created on first use. */
async function placeIn(tx: Db, key: string, o: Parameters<typeof placeOf>[1] = {}) {
  const place = await placeOf(tx, o);
  const [sub] = await tx.execute<{ id: string }>(sql`select id from subdivisions where key = ${key}`).then((r) => r.rows);
  await tx.update(geoObjects).set({ subdivisionId: sub!.id }).where(eq(geoObjects.id, place.objectId));
  return place;
}

const setup = async (tx: Db) => {
  const key = `XT-${newId()}`;
  await insertTestSubdivision(tx, key, [20, 34, 22, 36]);
  return key;
};

describe("verdictsByThreshold", () => {
  it("two domains confirm at N=2 only; three domains up to N=3", () =>
    withRollback(async (tx) => {
      const key = await setup(tx);
      const two = await placeIn(tx, key);
      const three = await placeIn(tx, key);
      for (const d of ["a", "b"]) await signalPage(tx, config, two, { domain: `${d}.example` });
      for (const d of ["a", "b", "c"]) await signalPage(tx, config, three, { domain: `${d}.example` });

      const v = await verdictsByThreshold(tx, key, [2, 3, 4], config);
      expect([...v.keys()]).toEqual([2, 3, 4]);
      expect([2, 3, 4].map((n) => v.get(n)!.get(two.placeId)!.status)).toEqual(["confirmed", "candidate", "candidate"]);
      expect([2, 3, 4].map((n) => v.get(n)!.get(three.placeId)!.status)).toEqual(["confirmed", "confirmed", "candidate"]);
      expect(v.get(3)!.get(two.placeId)!.reason).toBe("2 von 3 unabhängigen Quellen");
    }));

  it("an authority ban is no_anchoring at every threshold", () =>
    withRollback(async (tx) => {
      const key = await setup(tx);
      const place = await placeIn(tx, key);
      for (const d of ["a", "b", "c"]) await signalPage(tx, config, place, { domain: `${d}.example` });
      await signalPage(tx, config, place, { domain: "port-police.example", kind: "prohibited", firstHand: false, pageKind: "authority", observedAt: "2025-06-01" });
      const v = await verdictsByThreshold(tx, key, [2, 3, 5], config);
      for (const n of [2, 3, 5]) expect(v.get(n)!.get(place.placeId)!.status, `N=${n}`).toBe("no_anchoring");
    }));

  it("a status an admin set stands at every threshold, except a confirmation against an authority ban", () =>
    withRollback(async (tx) => {
      const key = await setup(tx);
      const confirmed = await placeIn(tx, key);
      await setPlaceStatusByAdmin(tx, { placeId: confirmed.placeId, status: "confirmed", from: "candidate", decidedBy: "admin@test.invalid" });
      const banned = await placeIn(tx, key);
      await setPlaceStatusByAdmin(tx, { placeId: banned.placeId, status: "confirmed", from: "candidate", decidedBy: "admin@test.invalid" });
      await signalPage(tx, config, banned, { domain: "port-police.example", kind: "prohibited", firstHand: false, pageKind: "authority" });

      const v = await verdictsByThreshold(tx, key, [2, 5], config);
      for (const n of [2, 5]) {
        expect(v.get(n)!.get(confirmed.placeId)!.status, `N=${n}`).toBe("confirmed");
        expect(v.get(n)!.get(banned.placeId)!.status, `N=${n}`).toBe("no_anchoring");
      }
    }));

  it("places of rejected, abandoned or other subdivisions are not decided", () =>
    withRollback(async (tx) => {
      const key = await setup(tx);
      const rejected = await placeIn(tx, key, { status: "rejected" });
      const other = await placeOf(tx);
      const v = await verdictsByThreshold(tx, key, [2], config);
      expect(v.get(2)!.has(rejected.placeId)).toBe(false);
      expect(v.get(2)!.has(other.placeId)).toBe(false);
    }));

  it("writes nothing to places or review_decisions", () =>
    withRollback(async (tx) => {
      const key = await setup(tx);
      const place = await placeIn(tx, key);
      for (const d of ["a", "b"]) await signalPage(tx, config, place, { domain: `${d}.example` });
      const snapshot = async () => ({
        places: JSON.stringify(await tx.select().from(places).where(eq(places.id, place.placeId))),
        decisions: (await tx.select().from(reviewDecisions)).length,
      });
      const before = await snapshot();
      await verdictsByThreshold(tx, key, [2, 3], config);
      expect(await snapshot()).toEqual(before);
    }));
});
