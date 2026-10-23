import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { wikidataSitelinks, type PoiCategory } from "@/lib/db/schema";
import type { BerthStateLanding } from "@/lib/db/schema/research-state";
import { addNames } from "@/lib/domain/gazetteer/names";
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
async function poi(tx: Tx, o: { m: number; category: PoiCategory; sitelinks?: number; name?: string }): Promise<string> {
  const wikidataId = o.sitelinks === undefined ? null : `Q${Math.floor(Math.random() * 1e12)}`;
  const id = await insertTestGeoObject(tx, { type: "poi", category: o.category, wikidataId, geom: geomFromGeoJson({ type: "Point", coordinates: [LON, north(o.m)] }) });
  if (wikidataId) await tx.insert(wikidataSitelinks).values({ wikidataId, sitelinks: o.sitelinks!, fetchedAt: new Date() });
  if (o.name) await addNames(tx, id, [{ name: o.name, language: "en", origin: "osm" }]);
  return id;
}

describe("reachable", () => {
  it("on foot: every category but landing within 1.5 km counting the detour, nearest first, with the factor applied", async () => {
    await withRollback(async (tx) => {
      const far = await poi(tx, { m: 1000, category: "food" }); // 1000 * 1.4 = 1400 m: just inside
      const near = await poi(tx, { m: 200, category: "supply" });
      await poi(tx, { m: 1100, category: "food" }); // 1540 m: outside
      await poi(tx, { m: 100, category: "landing" });
      const out = await reachable(tx, landing, config, { transportFact: false, factSubjects: [] });
      expect(out.map((n) => [n.geoObjectId, n.access, n.category])).toEqual([[near, "foot", "supply"], [far, "foot", "food"]]);
      expect(out[0]!.distanceM).toBeCloseTo(280, -1);
      expect(out[1]!.distanceM).toBeCloseTo(1400, -1);
    });
  });

  it("a bus stop 2 km away gives no bus access: the sight 10 km away is not reached", async () => {
    await withRollback(async (tx) => {
      await poi(tx, { m: 2000, category: "transport" });
      await poi(tx, { m: 10000, category: "culture", sitelinks: 8 });
      expect(await reachable(tx, landing, config, { transportFact: false, factSubjects: [] })).toEqual([]);
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
      const out = await reachable(tx, landing, config, { transportFact: false, factSubjects: [] });
      expect(out.map((n) => [n.geoObjectId, n.access])).toEqual([[stop, "foot"], [monastery, "transport"]]);
    });
  });

  it("a free taxi or bus fact opens the transport access without a stop near", async () => {
    await withRollback(async (tx) => {
      const monastery = await poi(tx, { m: 6000, category: "culture", sitelinks: 12 });
      const out = await reachable(tx, landing, config, { transportFact: true, factSubjects: [] });
      expect(out).toEqual([{ geoObjectId: monastery, category: "culture", distanceM: expect.closeTo(8400, -2), access: "transport" }]);
    });
  });

  it("a well known place within foot distance is listed once, on foot", async () => {
    await withRollback(async (tx) => {
      const chapel = await poi(tx, { m: 300, category: "culture", sitelinks: 20 });
      const out = await reachable(tx, landing, config, { transportFact: true, factSubjects: [] });
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
      const out = await reachable(tx, twoPoints, config, { transportFact: false, factSubjects: [] });
      expect(out).toHaveLength(1);
      expect(out[0]!.geoObjectId).toBe(spot);
      expect(out[0]!.distanceM).toBeCloseTo(140, -1);
      expect(await reachable(tx, [landing[0]!], config, { transportFact: true, factSubjects: [] })).toEqual([]);
    });
  });

  it("at most 10 per category, nearest kept", async () => {
    await withRollback(async (tx) => {
      for (let i = 0; i < 12; i++) await poi(tx, { m: 50 + i * 10, category: "food" });
      const out = await reachable(tx, landing, config, { transportFact: false, factSubjects: [] });
      expect(out).toHaveLength(10);
      expect(Math.max(...out.map((n) => n.distanceM))).toBeLessThan(200);
    });
  });
});

describe("things without facts (spec 5.7)", () => {
  it("a sight without sitelinks and without a fact is not listed; with a fact about it it is", async () => {
    await withRollback(async (tx) => {
      const ruin = await poi(tx, { m: 700, category: "culture", name: "Old Venetian Ruin" });
      expect(await reachable(tx, landing, config, { transportFact: false, factSubjects: [] })).toEqual([]);
      expect(await reachable(tx, landing, config, { transportFact: false, factSubjects: ["Venetian ruin"] })).toMatchObject([{ geoObjectId: ruin, access: "foot" }]);
      expect(await reachable(tx, landing, config, { transportFact: false, factSubjects: ["the old venetian ruin on the hill"] })).toMatchObject([{ geoObjectId: ruin }]);
      expect(await reachable(tx, landing, config, { transportFact: false, factSubjects: ["taverna nikos"] })).toEqual([]);
    });
  });

  it("a sight within foot distance with enough sitelinks is listed; one in an always category needs nothing", async () => {
    await withRollback(async (tx) => {
      const known = await poi(tx, { m: 700, category: "culture", sitelinks: 6 });
      const few = await poi(tx, { m: 700, category: "nature", sitelinks: 2 });
      const bakery = await poi(tx, { m: 500, category: "bakery" });
      const activity = await poi(tx, { m: 400, category: "active" });
      const out = await reachable(tx, landing, config, { transportFact: false, factSubjects: [] });
      expect(out.map((n) => n.geoObjectId).sort()).toEqual([known, bakery].sort());
      expect(out.map((n) => n.geoObjectId)).not.toContain(few);
      expect(out.map((n) => n.geoObjectId)).not.toContain(activity);
    });
  });

  it("a fact about a thing beyond foot distance that is no sight lists nothing", async () => {
    await withRollback(async (tx) => {
      await poi(tx, { m: 3000, category: "food", name: "Taverna Nikos" });
      expect(await reachable(tx, landing, config, { transportFact: true, factSubjects: ["taverna nikos"] })).toEqual([]);
    });
  });
});

describe("transport fact", () => {
  const fact = (subjectCategory: string | null, o: { tone?: "positive" | "negative" | "neutral" | null; observedAt?: string; factId?: string } = {}) => ({
    factId: o.factId ?? "f",
    subjectCategory,
    tone: o.tone ?? null,
    observedAt: o.observedAt ?? "2025-06-15",
  });

  it("a subject category containing a configured keyword counts, normalized", () => {
    const k = config.research.state.transportKeywords;
    expect(hasTransportFact([fact("Bus stop")], k)).toBe(true);
    expect(hasTransportFact([fact(" TAXI ")], k)).toBe(true);
    expect(hasTransportFact([fact("Λεωφορείο")], k)).toBe(true);
    expect(hasTransportFact([fact("food"), fact(null)], k)).toBe(false);
  });

  it("a negative transport fact does not open access: „Kein Taxi im Ort“", () => {
    const k = config.research.state.transportKeywords;
    expect(hasTransportFact([fact("taxi", { tone: "negative" })], k)).toBe(false);
  });

  it("the newest transport fact decides: a bus discontinued in 2025 closes the bus of 2019, a newer bus reopens it", () => {
    const k = config.research.state.transportKeywords;
    const bus2019 = fact("bus", { tone: "positive", observedAt: "2019-06-01", factId: "a" });
    const stopped2025 = fact("bus", { tone: "negative", observedAt: "2025-06-01", factId: "b" });
    expect(hasTransportFact([bus2019, stopped2025], k)).toBe(false);
    expect(hasTransportFact([stopped2025, bus2019], k)).toBe(false);
    expect(hasTransportFact([bus2019, stopped2025, fact("taxi", { observedAt: "2026-05-01", factId: "c" })], k)).toBe(true);
    // a newer fact about food does not decide about transport
    expect(hasTransportFact([bus2019, stopped2025, fact("food", { tone: "positive", observedAt: "2026-05-01", factId: "d" })], k)).toBe(false);
  });

  it("on the same date a negative transport fact wins", () => {
    const k = config.research.state.transportKeywords;
    expect(hasTransportFact([fact("bus", { tone: "positive", factId: "a" }), fact("taxi", { tone: "negative", factId: "b" })], k)).toBe(false);
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
