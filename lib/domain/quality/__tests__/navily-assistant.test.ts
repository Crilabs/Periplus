import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { LonLat } from "@/lib/domain/geometry/water";
import { COMPARISON_ATTRIBUTES, comparisonValues, type ComparisonSubject } from "../comparison-values";
import {
  loadNavilyFromEnv,
  matchPlacesToSpots,
  nameSimilarity,
  navilyCoverage,
  proposeResults,
} from "../navily-assistant";
import { loadNavilySpots, type NavilySpot } from "../navily-sample";

// Synthetic places and spots around 21.0° E / 35.2° N (outside the pilot box); nothing touches a database.

const cfg = getConfig().quality.navily;
const affixes = getConfig().nameAffixes;
const FIXTURE = path.join(process.cwd(), "test/fixtures/navily/sample.json");

const AT: LonLat = { lon: 21.0, lat: 35.2 };
/** A point `m` metres north of `AT` (1° latitude = 111 195 m on the haversine sphere). */
const north = (m: number): LonLat => ({ lon: AT.lon, lat: AT.lat + m / 111_195 });

type Place = Pick<ComparisonSubject, "placeId" | "kind" | "status" | "position" | "anchorPosition" | "names">;
const place = (
  placeId: string,
  names: string[],
  position: LonLat = AT,
  kind: Place["kind"] = "anchorage",
  patch: Partial<Pick<Place, "status" | "anchorPosition">> = {},
): Place => ({ placeId, kind, status: "confirmed", position, anchorPosition: null, names, ...patch });

function spot(over: Partial<NavilySpot> = {}): NavilySpot {
  return { lat: AT.lat, lon: AT.lon, prot: null, seabeds: null, name: null, kind: "mooring", type: null, water: null, shop: null, ...over };
}

function subject(attributes: Record<string, unknown>, patch: Partial<ComparisonSubject> = {}): ComparisonSubject {
  return {
    placeId: "0190a1b2-0000-7000-8000-000000000001",
    publicId: null,
    name: "Kolona",
    names: ["Kolona"],
    kind: "anchorage",
    status: "confirmed",
    position: AT,
    anchorPosition: null,
    attributes,
    profileVersion: 1,
    ...patch,
  };
}
const valuesOf = (attributes: Record<string, unknown>, patch: Partial<ComparisonSubject> = {}) =>
  comparisonValues(subject(attributes, patch), cfg);

describe("nameSimilarity", () => {
  it("compares the name cores, transliterated, best own name wins", () => {
    expect(nameSimilarity(["Vathi"], "Ormos Vathy", affixes)).toBe(0.5);
    expect(nameSimilarity(["Όρμος Βαθύ"], "Vathy Bay", affixes)).toBe(1);
    expect(nameSimilarity(["Kolona", "Vathi"], "Vathi", affixes)).toBe(1);
    expect(nameSimilarity(["Vathi"], null, affixes)).toBe(0);
    expect(nameSimilarity([], "Vathi", affixes)).toBe(0);
  });

  it("takes the better of the full forms and the cores: Πόρτο Χέλι ↔ Porto Heli (ruling M7-B-R2)", () => {
    // cores only („cheli“ vs „heli“) give 0.375, below nameMin; the full forms give 9/14 (ruling T7-R1)
    expect(nameSimilarity(["Πόρτο Χέλι"], "Porto Heli", affixes)).toBeCloseTo(9 / 14, 6);
    expect(nameSimilarity(["Porto Cheli"], "Porto Heli", affixes)).toBeCloseTo(9 / 14, 6);
    // the core still wins where the affix differs
    expect(nameSimilarity(["Όρμος Βαθύ"], "Vathy Bay", affixes)).toBe(1);
  });
});

describe("matchPlacesToSpots", () => {
  it("'Ormos Vathy' matches Vathi 400 m away", () => {
    const [m] = matchPlacesToSpots([place("p1", ["Vathi"])], [spot({ name: "Ormos Vathy", ...north(400) })], cfg, affixes);
    expect(m).toMatchObject({ placeId: "p1", spotIndex: 0, nameSimilarity: 0.5 });
    expect(m!.distanceM).toBeCloseTo(400, 0);
  });

  it("a same-named spot 1.5 km away is no match", () => {
    expect(matchPlacesToSpots([place("p1", ["Vathi"])], [spot({ name: "Vathi", ...north(1500) })], cfg, affixes)).toEqual([
      { placeId: "p1", spotIndex: null, distanceM: null, nameSimilarity: null },
    ]);
  });

  it("a strong name matches up to the maximum radius, a weak one only within the name radius", () => {
    const strong = matchPlacesToSpots([place("p1", ["Vathi"])], [spot({ name: "Vathi", ...north(900) })], cfg, affixes);
    expect(strong[0]!.spotIndex).toBe(0);
    const weak = matchPlacesToSpots([place("p1", ["Vathi"])], [spot({ name: "Ormos Vathy", ...north(700) })], cfg, affixes);
    expect(weak[0]!.spotIndex).toBeNull();
    const unrelated = matchPlacesToSpots([place("p1", ["Kolona"])], [spot({ name: "Vathi", ...north(300) })], cfg, affixes);
    expect(unrelated[0]!.spotIndex).toBeNull();
  });

  it("one navily spot is matched to at most one place, marina before bay", () => {
    const places = [place("bay", ["Ormos Poros"], north(200)), place("marina", ["Marina Poros"], north(250), "marina")];
    const matches = matchPlacesToSpots(places, [spot({ name: "Poros", kind: "port" })], cfg, affixes);
    expect(matches.map((m) => [m.placeId, m.spotIndex])).toEqual([
      ["bay", null],
      ["marina", 0],
    ]);
  });

  it("each place takes the best spot; the nearer of two equal spots wins", () => {
    const spots = [spot({ name: "Vathi", ...north(300) }), spot({ name: "Vathi", ...north(100) })];
    const [m] = matchPlacesToSpots([place("p1", ["Vathi"])], spots, cfg, affixes);
    expect(m!.spotIndex).toBe(1);
  });

  it("Πόρτο Χέλι marina matches the Navily port Porto Heli 300 m away (ruling M7-B-R2)", () => {
    const [m] = matchPlacesToSpots(
      [place("ph", ["Πόρτο Χέλι"], AT, "marina")],
      [spot({ name: "Porto Heli", kind: "port", ...north(300) })],
      cfg,
      affixes,
    );
    expect(m).toMatchObject({ spotIndex: 0 });
    expect(m!.nameSimilarity).toBeCloseTo(9 / 14, 6);
  });

  it("kind before similarity class: bay Vathi takes the mooring Vathy 50 m away, not the port Vathia 300 m away", () => {
    // both names are in the class „named“ (≥ nameMin, < nameStrongMin): Vathy 0.5, Vathia 0.625
    expect(nameSimilarity(["Vathi"], "Vathia", affixes)).toBe(0.625);
    const spots = [spot({ name: "Vathia", kind: "port", ...north(300) }), spot({ name: "Vathy", kind: "mooring", ...north(50) })];
    const [m] = matchPlacesToSpots([place("bay", ["Vathi"])], spots, cfg, affixes);
    expect(m!.spotIndex).toBe(1);
    // a strong name still outranks a merely similar one
    const strong = [spot({ name: "Vathi", kind: "mooring", ...north(400) }), spot({ name: "Vathy", kind: "mooring", ...north(50) })];
    expect(matchPlacesToSpots([place("bay", ["Vathi"])], strong, cfg, affixes)[0]!.spotIndex).toBe(0);
  });

  it("kind before similarity class, bay only (ruling M7-B-R3): with no harbour place the bay Vathi takes the mooring Vathy 50 m away, not the port Vathi 800 m away", () => {
    // strong (Vathi = Vathi, 1.0) vs named (Vathy 0.5): the class alone would give the bay the incompatible port
    expect(nameSimilarity(["Vathi"], "Vathi", affixes)).toBe(1);
    const spots = [spot({ name: "Vathi", kind: "port", ...north(800) }), spot({ name: "Vathy", kind: "mooring", ...north(50) })];
    const [m] = matchPlacesToSpots([place("bay", ["Vathi"])], spots, cfg, affixes);
    expect(m!.spotIndex).toBe(1);
    expect(m!.distanceM).toBeCloseTo(50, 0);
    // without a compatible candidate the bay still takes the port
    expect(matchPlacesToSpots([place("bay", ["Vathi"])], [spots[0]!], cfg, affixes)[0]!.spotIndex).toBe(0);
  });

  it("confirmed places match first: a rejected duplicate never takes the spot of a confirmed place (ruling M7-B-R2)", () => {
    const places = [
      place("dup", ["Kolona"], north(10), "anchorage", { status: "rejected" }),
      place("real", ["Kolona"], north(80)),
    ];
    const spots = [spot({ name: "Kolona" }), spot({ ...north(15) })];
    // pass 1: the confirmed place takes the named spot (the duplicate is nearer to it); pass 2: the duplicate gets the leftover
    expect(matchPlacesToSpots(places, spots, cfg, affixes).map((m) => [m.placeId, m.spotIndex])).toEqual([
      ["dup", 1],
      ["real", 0],
    ]);
    expect(matchPlacesToSpots(places, spots.slice(0, 1), cfg, affixes).map((m) => [m.placeId, m.spotIndex])).toEqual([
      ["dup", null],
      ["real", 0],
    ]);
  });

  it("matches on the delivered point: the anchor position of a bay, the place point of a harbour", () => {
    const anchor = north(300);
    const bay = place("bay", ["Kolona"], AT, "anchorage", { anchorPosition: anchor });
    const [m] = matchPlacesToSpots([bay], [spot({ ...anchor })], cfg, affixes);
    expect(m).toMatchObject({ spotIndex: 0, distanceM: 0 });
    const port = place("port", ["Kolona"], AT, "port", { anchorPosition: anchor });
    expect(matchPlacesToSpots([port], [spot({ ...anchor, kind: "port" })], cfg, affixes)[0]!.spotIndex).toBeNull();
  });

  it("greedy: a place whose best spot goes to another place falls back to its next candidate", () => {
    const places = [place("a", ["Kolona"], north(60)), place("b", ["Vathi"], north(40))];
    const spots = [spot({ name: "Kolona", ...north(50) }), spot({ ...north(140) })];
    // a takes the named spot 10 m away (strong); b, 10 m from it too, falls back to the nameless spot 100 m away
    expect(matchPlacesToSpots(places, spots, cfg, affixes).map((m) => [m.placeId, m.spotIndex])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("ties on kind, class and distance go to the lower place index, then the lower spot index", () => {
    const twins = [place("first", ["Kolona"]), place("second", ["Kolona"])];
    expect(matchPlacesToSpots(twins, [spot({ name: "Kolona" })], cfg, affixes).map((m) => m.spotIndex)).toEqual([0, null]);
    const [m] = matchPlacesToSpots([place("p", ["Kolona"])], [spot({ name: "Kolona" }), spot({ name: "Kolona" })], cfg, affixes);
    expect(m!.spotIndex).toBe(0);
  });

  it("a nameless spot 120 m away matches by distance alone", () => {
    const [m] = matchPlacesToSpots([place("p1", ["Kolona"])], [spot({ ...north(120) })], cfg, affixes);
    expect(m).toMatchObject({ placeId: "p1", spotIndex: 0, nameSimilarity: 0 });
    const [far] = matchPlacesToSpots([place("p1", ["Kolona"])], [spot({ ...north(200) })], cfg, affixes);
    expect(far!.spotIndex).toBeNull();
  });
});

describe("proposeResults", () => {
  const own = { position: AT };
  const full = {
    "shelter.N": 0.9,
    "shelter.NE": 0.8,
    "shelter.E": 0.1,
    "shelter.SE": 0.1,
    "shelter.S": 0.1,
    "shelter.SW": 0.1,
    "shelter.W": 0.1,
    "shelter.NW": 0.7,
    seabed: [
      { type: "weed", share: 0.6 },
      { type: "sand", share: 0.4 },
    ],
    "mooring.buoys": { present: true, count: 12 },
    "services.water": true,
    "highlight.supply": { present: false },
    "highlight.food": { present: true, names: ["Taverna"] },
    "depth.min": 4,
  };

  it("matches a place whose values agree with the spot", () => {
    const p = proposeResults(
      valuesOf(full),
      own,
      spot({ prot: ["N", "ne", "nw"], seabeds: ["algae"], type: "buoy", water: true, shop: false }),
      cfg,
    );
    expect(p).toEqual({
      existence: "match",
      position: "match",
      "shelter.N": "match",
      "shelter.NE": "match",
      "shelter.E": "match",
      "shelter.SE": "match",
      "shelter.S": "match",
      "shelter.SW": "match",
      "shelter.W": "match",
      "shelter.NW": "match",
      depth: "not_at_navily",
      seabed: "match",
      "mooring.buoys": "match",
      "services.water": "match",
      "highlight.supply": "match",
      "highlight.food": "not_at_navily",
    });
  });

  it("missing prot proposes not_at_navily for all sectors", () => {
    const p = proposeResults(valuesOf(full), own, spot({ prot: null }), cfg);
    for (const a of COMPARISON_ATTRIBUTES.filter((k) => k.startsWith("shelter."))) expect(p[a]).toBe("not_at_navily");
    // a sector open at Navily but protected at Periplus is a deviation; own value missing too
    const q = proposeResults(valuesOf({ "shelter.N": 0.9 }), own, spot({ prot: ["s"] }), cfg);
    expect([q["shelter.N"], q["shelter.S"], q["shelter.E"]]).toEqual(["deviation", "deviation", "deviation"]);
  });

  it("algae matches own weed; own seabed missing is a deviation", () => {
    const withSeabed = (seabeds: string[] | null) => proposeResults(valuesOf(full), own, spot({ seabeds }), cfg).seabed;
    expect(withSeabed(["algae"])).toBe("match");
    expect(withSeabed(["rock"])).toBe("deviation");
    expect(withSeabed(null)).toBe("not_at_navily");
    expect(withSeabed([])).toBe("not_at_navily");
    // prototype members are no seabed names
    expect(withSeabed(["constructor"])).toBe("not_at_navily");
    expect(withSeabed(["__proto__", "toString"])).toBe("not_at_navily");
    expect(proposeResults(valuesOf({}), own, spot({ seabeds: ["algae"] }), cfg).seabed).toBe("deviation");
  });

  it("depth and highlight.food are always not_at_navily", () => {
    for (const s of [spot({ type: "buoy", water: true, shop: true, prot: ["n"], seabeds: ["sand"] }), null]) {
      const p = proposeResults(valuesOf(full), own, s, cfg);
      expect([p.depth, p["highlight.food"]]).toEqual(["not_at_navily", "not_at_navily"]);
    }
  });

  it("buoys only at a navily buoy spot; water and supply against water and shop", () => {
    const noBuoys = valuesOf({ ...full, "mooring.buoys": { present: false } });
    expect(proposeResults(noBuoys, own, spot({ type: "buoy" }), cfg)["mooring.buoys"]).toBe("deviation");
    expect(proposeResults(noBuoys, own, spot({ type: "bay" }), cfg)["mooring.buoys"]).toBe("not_at_navily");
    expect(proposeResults(valuesOf({}), own, spot({ type: "buoy" }), cfg)["mooring.buoys"]).toBe("deviation");

    const p = proposeResults(valuesOf(full), own, spot({ water: false, shop: true }), cfg);
    expect([p["services.water"], p["highlight.supply"]]).toEqual(["deviation", "deviation"]);
    const unknown = proposeResults(valuesOf(full), own, spot({ water: null, shop: null }), cfg);
    expect([unknown["services.water"], unknown["highlight.supply"]]).toEqual(["not_at_navily", "not_at_navily"]);
    const missing = proposeResults(valuesOf({}), own, spot({ water: true, shop: false }), cfg);
    expect([missing["services.water"], missing["highlight.supply"]]).toEqual(["deviation", "deviation"]);
  });

  it("position matches within the tolerance", () => {
    expect(proposeResults(valuesOf(full), own, spot({ ...north(140) }), cfg).position).toBe("match");
    expect(proposeResults(valuesOf(full), own, spot({ ...north(160) }), cfg).position).toBe("deviation");
  });

  it("an unmatched place proposes existence deviation and nothing else", () => {
    const p = proposeResults(valuesOf(full), own, null, cfg);
    expect(p.existence).toBe("deviation");
    expect(Object.entries(p).filter(([a]) => a !== "existence").every(([, r]) => r === "not_at_navily")).toBe(true);
    expect(Object.keys(p).sort()).toEqual([...COMPARISON_ATTRIBUTES].sort());
    // existence compares the status: a place that is no confirmed place agrees with a missing spot
    expect(proposeResults(valuesOf(full, { status: "rejected" }), own, null, cfg).existence).toBe("match");
    expect(proposeResults(valuesOf(full, { status: "rejected" }), own, spot(), cfg).existence).toBe("deviation");
  });

  it("proposals carry results only", async () => {
    const spots = await loadNavilySpots(FIXTURE);
    const values = valuesOf(full);
    const p = proposeResults(values, own, spots[0]!, cfg);
    expect(JSON.stringify(p)).not.toMatch(/NAVILY-ONLY-NAME|987654321|navily\.com/);
    for (const r of Object.values(p)) expect(["match", "deviation", "not_at_navily"]).toContain(r);
  });
});

describe("navilyCoverage", () => {
  it("coverage counts only spots inside the area against all confirmed places", () => {
    const inArea = (p: LonLat) => p.lat < 35.5;
    const places = [place("a", ["Vathi"]), place("b", ["Kolona"], north(5000))];
    const spots = [
      spot({ name: "Vathi", ...north(50) }), // matched to a
      spot({ name: "Elsewhere", ...north(20_000) }), // in the area, unmatched
      spot({ name: "Kolona", lat: 36.0, lon: AT.lon }), // outside the area
      spot({ ...north(5050) }), // nameless, 50 m from b
    ];
    expect(navilyCoverage(places, spots, inArea, cfg, affixes)).toEqual({ spots: 3, matched: 2, ratio: 2 / 3, unmatchedSpotIndexes: [1] });
    expect(navilyCoverage(places, [], inArea, cfg, affixes)).toEqual({ spots: 0, matched: 0, ratio: null, unmatchedSpotIndexes: [] });
  });

  it("a spot only a non-confirmed place matched has no confirmed place", () => {
    const places = [place("a", ["Vathi"]), place("dup", ["Kolona"], north(3000), "anchorage", { status: "candidate" })];
    const spots = [spot({ name: "Vathi", ...north(50) }), spot({ name: "Kolona", ...north(3000) })];
    expect(navilyCoverage(places, spots, () => true, cfg, affixes)).toEqual({ spots: 2, matched: 1, ratio: 0.5, unmatchedSpotIndexes: [1] });
  });
});

describe("loadNavilyFromEnv", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "navily-env-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is null without NAVILY_SPOTS_PATH and loads the file when set", async () => {
    expect(await loadNavilyFromEnv({ NAVILY_SPOTS_PATH: undefined })).toBeNull();
    const spots = await loadNavilyFromEnv({ NAVILY_SPOTS_PATH: FIXTURE });
    expect(spots).toHaveLength(3);
  });

  it("names the path of a missing or broken file, never its content", async () => {
    const missing = path.join(dir, "missing.json");
    await expect(loadNavilyFromEnv({ NAVILY_SPOTS_PATH: missing })).rejects.toThrow(missing);
    const broken = path.join(dir, "broken.json");
    await writeFile(broken, '[{"lat": "NAVILY-ONLY-NAME"}]');
    const err = await loadNavilyFromEnv({ NAVILY_SPOTS_PATH: broken }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain(broken);
    expect(err?.message).not.toContain("NAVILY-ONLY-NAME");
  });
});
