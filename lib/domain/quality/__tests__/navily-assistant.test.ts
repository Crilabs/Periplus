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

type Place = Pick<ComparisonSubject, "placeId" | "kind" | "position" | "names">;
const place = (placeId: string, names: string[], position: LonLat = AT, kind: Place["kind"] = "anchorage"): Place => ({
  placeId,
  kind,
  position,
  names,
});

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
