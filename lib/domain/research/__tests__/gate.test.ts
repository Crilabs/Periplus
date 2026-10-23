import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, places, restrictedAreas, reviewDecisions } from "@/lib/db/schema";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { createReviewTask } from "@/lib/domain/review";
import { evaluateGate } from "@/lib/domain/research/gate-navily";
import { insertComputation } from "@/test/consolidation";
import { newId } from "@/lib/domain/ids";
import { setPlaceStatusByAdmin } from "@/lib/domain/place-status";
import { verdictsByThreshold } from "@/lib/domain/research/gate";
import { placeOf } from "@/test/confirmation";
import { withRollback } from "@/test/db";
import { signalPage as signalPageIn } from "@/test/research-signals";
import { insertTestSubdivision } from "@/test/text";

/* The verdicts per confirmation threshold (plan N3 task 1) against real Postgres; nothing is written. */

const config: AppConfig = loadConfig("config");
const signalPage = (tx: Db, place: { placeId: string; objectId: string }, o: Parameters<typeof signalPageIn>[3]) => signalPageIn(tx, config, place, o);

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
      for (const d of ["a", "b"]) await signalPage(tx, two, { domain: `${d}.example` });
      for (const d of ["a", "b", "c"]) await signalPage(tx, three, { domain: `${d}.example` });

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
      for (const d of ["a", "b", "c"]) await signalPage(tx, place, { domain: `${d}.example` });
      await signalPage(tx, place, { domain: "port-police.example", kind: "prohibited", firstHand: false, pageKind: "authority", observedAt: "2025-06-01" });
      const v = await verdictsByThreshold(tx, key, [2, 3, 5], config);
      for (const n of [2, 3, 5]) expect(v.get(n)!.get(place.placeId)!.status, `N=${n}`).toBe("no_anchoring");
    }));

  it("a marina with a younger no_space is confirmed at N=2 (harbourIgnoredNegativeKinds), a bay is not", () =>
    withRollback(async (tx) => {
      const key = await setup(tx);
      const marina = await placeIn(tx, key, { kind: "marina" });
      const bay = await placeIn(tx, key);
      await signalPage(tx, marina, { domain: "marina-x.example", kind: "listed_as_berth", firstHand: false, pageKind: "marina", observedAt: "2024-01-01" });
      await signalPage(tx, marina, { domain: "sail-a.example", kind: "berthed", observedAt: "2024-06-01" });
      for (const d of ["a", "b"]) await signalPage(tx, bay, { domain: `${d}.example`, observedAt: "2024-06-01" });
      for (const place of [marina, bay]) await signalPage(tx, place, { domain: "forum.example", kind: "no_space", firstHand: false, pageKind: "forum", observedAt: "2025-08-01" });
      const v = await verdictsByThreshold(tx, key, [2], config);
      expect(v.get(2)!.get(marina.placeId)!.status).toBe("confirmed");
      expect(v.get(2)!.get(bay.placeId)!.status).toBe("candidate");
    }));

  it("a status an admin set stands at every threshold, except a confirmation against an authority ban", () =>
    withRollback(async (tx) => {
      const key = await setup(tx);
      const confirmed = await placeIn(tx, key);
      await setPlaceStatusByAdmin(tx, { placeId: confirmed.placeId, status: "confirmed", from: "candidate", decidedBy: "admin@test.invalid" });
      const banned = await placeIn(tx, key);
      await setPlaceStatusByAdmin(tx, { placeId: banned.placeId, status: "confirmed", from: "candidate", decidedBy: "admin@test.invalid" });
      await signalPage(tx, banned, { domain: "port-police.example", kind: "prohibited", firstHand: false, pageKind: "authority" });

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
      for (const d of ["a", "b"]) await signalPage(tx, place, { domain: `${d}.example` });
      const snapshot = async () => ({
        places: JSON.stringify(await tx.select().from(places).where(eq(places.id, place.placeId))),
        decisions: (await tx.select().from(reviewDecisions)).length,
      });
      const before = await snapshot();
      await verdictsByThreshold(tx, key, [2, 3], config);
      expect(await snapshot()).toEqual(before);
    }));

  it("a candidate held by an open duplicate review stays a candidate at every threshold", () =>
    withRollback(async (tx) => {
      const key = await setup(tx);
      const place = await placeIn(tx, key);
      for (const d of ["a", "b", "c"]) await signalPage(tx, place, { domain: `${d}.example` });
      await createReviewTask(tx, { kind: "place_candidate", subjectType: "geo_object_pair", subjectId: `00000000-0000-4000-8000-000000000000:${place.objectId}`, context: {} });
      const v = await verdictsByThreshold(tx, key, [2, 3], config);
      for (const n of [2, 3]) expect(v.get(n)!.get(place.placeId), `N=${n}`).toMatchObject({ status: "candidate", reason: expect.stringMatching(/^offene Dubletten-Prüfung/) });
    }));

  it("a candidate in a banning restricted area is no_anchoring", () =>
    withRollback(async (tx) => {
      const key = await setup(tx);
      const place = await placeIn(tx, key);
      for (const d of ["a", "b"]) await signalPage(tx, place, { domain: `${d}.example` });
      const square: GeoJSON.Polygon = { type: "Polygon", coordinates: [[[20.99, 35.19], [21.01, 35.19], [21.01, 35.21], [20.99, 35.21], [20.99, 35.19]]] };
      const [area] = await tx.insert(restrictedAreas).values({ kind: "military", geom: sql`${geomFromGeoJson(square)}` }).returning({ id: restrictedAreas.id });
      await insertComputation(tx, place.objectId, "restriction", {
        prohibitions: [{ kind: "military", restrictedAreaId: area!.id, sourceRef: null, share: 1, anchoringBan: true }],
      });
      const v = await verdictsByThreshold(tx, key, [2], config);
      expect(v.get(2)!.get(place.placeId)).toMatchObject({ status: "no_anchoring", reason: "Sperrgebiet" });
      expect((await tx.select().from(places).where(eq(places.id, place.placeId)))[0]!.status).toBe("candidate");
    }));

  it("a rejected place in includePlaceIds gets the pure rule verdict and stays in the gate count", () =>
    withRollback(async (tx) => {
      const key = await setup(tx);
      const place = await placeIn(tx, key, { status: "rejected" });
      for (const d of ["a", "b"]) await signalPage(tx, place, { domain: `${d}.example` });
      expect((await verdictsByThreshold(tx, key, [2], config)).get(2)!.has(place.placeId)).toBe(false);
      const v = await verdictsByThreshold(tx, key, [2, 3], config, { includePlaceIds: [place.placeId] });
      expect([2, 3].map((n) => v.get(n)!.get(place.placeId)!.status)).toEqual(["confirmed", "candidate"]);

      const gatePlace = { placeId: place.placeId, kind: "anchorage" as const, status: "rejected" as const, statusReason: null, position: { lon: 21, lat: 35.2 }, anchorPosition: null, names: ["Alpha"], verdicts: new Map([...v].map(([n, m]) => [n, m.get(place.placeId)!])), hasNames: true, hasHits: true };
      const r = evaluateGate({ thresholds: [2, 3], places: [gatePlace], spots: [], decisions: new Map([[place.placeId, "not_berth" as const]]) }, config);
      expect(r.rows[0]).toMatchObject({ threshold: 2, confirmed: 1, decidedNotBerth: 1, correct: 0 });
      expect(r.rows[0]!.correctness).toBe(0);
    }));
});
