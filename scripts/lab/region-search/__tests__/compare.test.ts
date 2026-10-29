import { describe, expect, it } from "vitest";
import { tileIdFor } from "../../../../lib/domain/tiles";
import type { NavilySpot } from "../../../../lib/domain/quality/navily-sample";
import { clusterLocated } from "../cluster";
import { denominators, measure, metricsFor, splitByArea } from "../compare";
import { coordinatesIn } from "../coords";
import type { Located } from "../locate";
import { renderReport } from "../report";

// Invented spots in the North Sea; nothing here is reference data.
const spot = (name: string, lat: number, lon: number, type = "anchor"): NavilySpot => ({ lat, lon, prot: null, seabeds: null, name, kind: "mooring", type, water: null, shop: null });
const spots: NavilySpot[] = [
  spot("Quellmund Cove", 54.2, 4.5), // covered at 100 m by a two-source web place
  spot("Quellmund Cove II", 54.2009, 4.5), // 100 m from the first: same bay cluster
  spot("Farrow Reach", 54.3, 4.7), // web place 500 m away
  spot("Nocked Bight", 54.4, 4.9), // nothing nearby
  spot("Verboten Bight", 54.45, 4.95, "prohibited"), // excluded
];
const tiles = [...new Set(spots.map((s) => tileIdFor(s.lon, s.lat)))];
const gate = { tiles: { all: tiles, worked: tiles }, bufferM: 300 };
const navilyCfg = { excludedTypes: ["prohibited", "dry-berthing"] };

function located(over: Partial<Located>): Located {
  return {
    url: "https://a.example.org/p",
    domain: "a.example.org",
    name: "Zorbakia",
    aliases: [],
    area: null,
    kind: "anchorage",
    coordinate: null,
    coordinateQuote: null,
    positionQuote: null,
    berthQuote: "we anchored in Zorbakia bay overnight in sand and had a quiet night",
    firstHand: true,
    pageKind: "trip_report",
    method: "gazetteer",
    lon: 4.5,
    lat: 54.2009,
    reason: null,
    gazId: "g1",
    ...over,
  };
}

const rows: Located[] = [
  located({}),
  located({ url: "https://b.example.org/p", domain: "b.example.org", berthQuote: "a lovely spot, we dropped the hook in the north corner and swam ashore", lat: 54.2012 }),
  located({ url: "https://c.example.org/p", domain: "c.example.org", lat: 54.3045, lon: 4.7, method: "coordinate", coordinate: { lat: 54.3045, lon: 4.7, precisionM: 90, text: "54°18.27'N 4°42'E" } }),
  located({ url: "https://d.example.org/p", domain: "d.example.org", lat: 54.21, lon: 4.6 }),
  located({ url: "https://e.example.org/p", domain: "e.example.org", lat: 54.21, lon: 4.6, berthQuote: "another crew's words about the same quiet bay, anchored in six metres" }),
  located({ method: null, lon: null, lat: null, reason: "no_match", positionQuote: "in the north-west corner of the bay" }),
  located({ url: "https://f.example.org/p", domain: "f.example.org", lat: 56.0, lon: 4.5 }), // outside the area's tiles
];

describe("denominators and measure", () => {
  const dens = denominators(spots, gate, navilyCfg);
  const { inside, outside } = splitByArea(rows, dens[0]!.tiles);
  const places = clusterLocated(inside, 300);

  it("excludes prohibited spots and clusters spots of one bay", () => {
    expect(dens[0]?.spots).toHaveLength(4);
    expect(dens[0]?.clusters).toHaveLength(3);
  });

  it("keeps a mention located outside the area's tiles out of the web places", () => {
    expect(outside).toHaveLength(1);
    expect(outside[0]?.domain).toBe("f.example.org");
    expect(inside).toHaveLength(rows.length - 1);
    expect(places.some((p) => p.lat > 55)).toBe(false);
  });

  it("counts coverage by distance, confirmation by strict sources, conflicts and unresolved reasons", () => {
    const m = measure(places, inside, dens[0]!);
    expect(m.covered1["150"]).toBe(2);
    expect(m.covered1["600"]).toBe(3);
    expect(m.confirmedStrict300).toBe(2);
    expect(m.clustersConfirmedStrict300).toBe(1);
    expect(m.conflicts300).toBe(1);
    expect(m.coordMentions.count).toBe(1);
    expect(m.coordMentions.medianDistanceM).toBeGreaterThan(400);
    expect(m.unresolved.no_match).toBe(1);
    expect(m.unresolvedWithPosition).toBe(1);
  });
});

describe("metricsFor", () => {
  it("splits by the denominator's own tiles and keeps model-located sources out of the binding figures", () => {
    const modelRows: Located[] = [
      located({ url: "https://m1.example.org/p", domain: "m1.example.org", lat: 54.3045, lon: 4.7, method: "gazetteer" }),
      located({ url: "https://m2.example.org/p", domain: "m2.example.org", lat: 54.3045, lon: 4.7, method: "model", berthQuote: "the model placed this quote, a different sentence about anchoring here" }),
    ];
    const dens = denominators(spots, gate, navilyCfg);
    const m = metricsFor([...rows, ...modelRows], dens[0]!, { copyMinSharedWords: 12, engineOf: () => ({ d: true, c: false }) });
    // the spot 500 m from that web place is not confirmed (one non-model source) without the model, confirmed with it at 600 m? no: 300 m rule
    expect(m.outside).toBe(1);
    expect(m.clustersConfirmedStrict300).toBe(1);
    expect(m.clustersConfirmedStrict300WithModel).toBe(1);
    // a model mention 100 m from the first spot adds the second source only in the "with model" column
    const m2 = metricsFor(
      [located({}), located({ url: "https://m3.example.org/p", domain: "m3.example.org", method: "model", lat: 54.2009, berthQuote: "a model-placed second source with its own words about the anchorage" })],
      dens[0]!,
      { copyMinSharedWords: 12, engineOf: () => ({ d: true, c: false }) },
    );
    expect(m2.clustersConfirmedStrict300).toBe(0);
    expect(m2.clustersConfirmedStrict300WithModel).toBe(1);
  });

  it("uses a larger tile set for a denominator that spans neighbouring tiles", () => {
    const far = spot("Farway Hole", 55.0, 4.5);
    const dens = denominators([...spots, far], { tiles: { all: tiles, worked: [...tiles, tileIdFor(4.5, 55.0)] }, bufferM: 300 }, navilyCfg);
    const m = metricsFor([...rows, located({ url: "https://g.example.org/p", domain: "g.example.org", lat: 55.0005, lon: 4.5 })], dens[1]!, { copyMinSharedWords: 12, engineOf: () => ({ d: true, c: false }) });
    expect(dens[1]?.spots).toHaveLength(5);
    expect(m.covered1["150"]).toBe(3);
  });
});

describe("renderReport", () => {
  it("holds counts only: no spot names, no coordinates", () => {
    const dens = denominators(spots, gate, navilyCfg);
    const places = clusterLocated(rows, 300);
    const report = renderReport({
      metrics: dens.map((d) => measure(places, rows, d)),
      outside: 1,
      costs: { totalEur: 1.23, byStage: { "search-d": 0.3, assess: 0.93 }, capEur: 40 },
      counts: { queriesD: 10, queriesC: 2, hitsD: 100, hitsC: 50, hitsBoth: 20, pages: 120, assessed: 110, counting: 40, mentions: 6, dropped: 2 },
      bearing: { d: 30, c: 25, both: 10 },
      topDomains: [{ domain: "a.example.org", pages: 3, mentions: 4 }],
      generatedAt: new Date("2026-10-29T10:00:00Z"),
    });
    for (const s of spots) expect(report).not.toContain(s.name!);
    expect(coordinatesIn(report)).toHaveLength(0);
    expect(report).toContain("a.example.org");
    expect(report).toContain("Tragende Seiten");
    expect(report).toMatch(/nur D 30, nur C 25, beide 10/);
  });
});
