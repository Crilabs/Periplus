import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { wikidataSitelinks, type PoiCategory } from "@/lib/db/schema";
import type { BerthStateLanding } from "@/lib/db/schema/research-state";
import { hasTransportFact, reachable, transportFactIn } from "@/lib/domain/research/reach";
import { insertPlace } from "@/test/consolidation";
import { seedPage, seedStatement } from "@/test/research-state";
import { withRollback } from "@/test/db";
import { insertTestGeoObject } from "@/test/text";

/*
 * What is reachable on land from a berth (plan N4a task 5): distance = straight line times the detour factor from
 * the nearest positioned landing point; on foot within 1.5 km, and with bus or taxi further for the well known.
 */

const config = getConfig();
const LON = 21.0;
const LAT = 35.2;
const M_PER_DEG = 111_195;
const north = (m: number) => LAT + m / M_PER_DEG;
const landing: BerthStateLanding[] = [
  { kind: "text", lon: null, lat: null, geoObjectId: null, description: "by dinghy" },
  { kind: "pier", lon: LON, lat: LAT, geoObjectId: null, description: null },
];

type Tx = Parameters<typeof insertTestGeoObject>[0];
async function poi(tx: Tx, o: { m: number; category: PoiCategory; sitelinks?: number }): Promise<string> {
  const wikidataId = o.sitelinks === undefined ? null : `Q${Math.floor(Math.random() * 1e12)}`;
  const id = await insertTestGeoObject(tx, { type: "poi", category: o.category, wikidataId, geom: geomFromGeoJson({ type: "Point", coordinates: [LON, north(o.m)] }) });
  if (wikidataId) await tx.insert(wikidataSitelinks).values({ wikidataId, sitelinks: o.sitelinks!, fetchedAt: new Date() });
  return id;
}

describe("reachable", () => {
  it("on foot: every category but landing within 1.5 km counting the detour, nearest first, with the factor applied", async () => {
    await withRollback(async (tx) => {
      const far = await poi(tx, { m: 1000, category: "food" }); // 1000 * 1.4 = 1400 m: just inside
      const near = await poi(tx, { m: 200, category: "supply" });
      await poi(tx, { m: 1100, category: "food" }); // 1540 m: outside
      await poi(tx, { m: 100, category: "landing" });
      const out = await reachable(tx, landing, config, { transportFact: false });
      expect(out.map((n) => [n.geoObjectId, n.access, n.category])).toEqual([[near, "foot", "supply"], [far, "foot", "food"]]);
      expect(out[0]!.distanceM).toBeCloseTo(280, -1);
      expect(out[1]!.distanceM).toBeCloseTo(1400, -1);
    });
  });

  it("a bus stop 2 km away gives no bus access: the sight 10 km away is not reached", async () => {
    await withRollback(async (tx) => {
      await poi(tx, { m: 2000, category: "transport" });
      await poi(tx, { m: 10000, category: "culture", sitelinks: 8 });
      expect(await reachable(tx, landing, config, { transportFact: false })).toEqual([]);
    });
  });

  it("a bus stop 800 m away on foot: a sight 10 km away with 8 sitelinks is reached by transport, one without sitelinks or with 4 is not", async () => {
    await withRollback(async (tx) => {
      const stop = await poi(tx, { m: 800, category: "transport" });
      const monastery = await poi(tx, { m: 10000, category: "culture", sitelinks: 8 });
      await poi(tx, { m: 9000, category: "culture" });
      await poi(tx, { m: 9000, category: "town", sitelinks: 4 });
      await poi(tx, { m: 12000, category: "culture", sitelinks: 8 }); // 16.8 km: beyond transportMaxM
      await poi(tx, { m: 9000, category: "food", sitelinks: 50 }); // not a transport category
      const out = await reachable(tx, landing, config, { transportFact: false });
      expect(out.map((n) => [n.geoObjectId, n.access])).toEqual([[stop, "foot"], [monastery, "transport"]]);
    });
  });

  it("a free taxi or bus fact opens the transport access without a stop near", async () => {
    await withRollback(async (tx) => {
      const monastery = await poi(tx, { m: 6000, category: "culture", sitelinks: 12 });
      const out = await reachable(tx, landing, config, { transportFact: true });
      expect(out).toEqual([{ geoObjectId: monastery, category: "culture", distanceM: expect.closeTo(8400, -2), access: "transport" }]);
    });
  });

  it("a well known place within foot distance is listed once, on foot", async () => {
    await withRollback(async (tx) => {
      const chapel = await poi(tx, { m: 300, category: "culture", sitelinks: 20 });
      const out = await reachable(tx, landing, config, { transportFact: true });
      expect(out.map((n) => [n.geoObjectId, n.access])).toEqual([[chapel, "foot"]]);
    });
  });

  it("the nearest positioned landing point counts; no positioned point, nothing", async () => {
    await withRollback(async (tx) => {
      const spot = await poi(tx, { m: 1000, category: "food" });
      const twoPoints: BerthStateLanding[] = [
        { kind: "pier", lon: LON, lat: north(-3000), geoObjectId: null, description: null },
        { kind: "beach", lon: LON, lat: north(900), geoObjectId: null, description: null },
      ];
      const out = await reachable(tx, twoPoints, config, { transportFact: false });
      expect(out).toHaveLength(1);
      expect(out[0]!.geoObjectId).toBe(spot);
      expect(out[0]!.distanceM).toBeCloseTo(140, -1);
      expect(await reachable(tx, [landing[0]!], config, { transportFact: true })).toEqual([]);
    });
  });

  it("at most 10 per category, nearest kept", async () => {
    await withRollback(async (tx) => {
      for (let i = 0; i < 12; i++) await poi(tx, { m: 50 + i * 10, category: "food" });
      const out = await reachable(tx, landing, config, { transportFact: false });
      expect(out).toHaveLength(10);
      expect(Math.max(...out.map((n) => n.distanceM))).toBeLessThan(200);
    });
  });
});

describe("transport fact", () => {
  it("a subject category containing a configured keyword counts, normalized", () => {
    const k = config.research.state.transportKeywords;
    expect(hasTransportFact([{ subjectCategory: "Bus stop" }], k)).toBe(true);
    expect(hasTransportFact([{ subjectCategory: " TAXI " }], k)).toBe(true);
    expect(hasTransportFact([{ subjectCategory: "Λεωφορείο" }], k)).toBe(true);
    expect(hasTransportFact([{ subjectCategory: "food" }, { subjectCategory: null }], k)).toBe(false);
  });

  it("is read from free facts of done units of the active extractor", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      expect(await transportFactIn(tx, placeId, config)).toBe(false);
      const bad = await seedPage(tx, config, placeId, { status: "failed" });
      await seedStatement(tx, placeId, bad, { statement: "taxi on request", subjectName: "Taxi", subjectCategory: "taxi" });
      expect(await transportFactIn(tx, placeId, config)).toBe(false);
      const ok = await seedPage(tx, config, placeId);
      await seedStatement(tx, placeId, ok, { statement: "a bus runs twice a day", subjectName: "Bus", subjectCategory: "bus" });
      expect(await transportFactIn(tx, placeId, config)).toBe(true);
    });
  });
});
