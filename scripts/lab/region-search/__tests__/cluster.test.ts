import { describe, expect, it } from "vitest";
import { clusterLocated, independentSources } from "../cluster";
import type { Located } from "../locate";

// Invented places, North Sea coordinates.
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
    lat: 54.2,
    reason: null,
    gazId: "g1",
    ...over,
  };
}

describe("clusterLocated", () => {
  it("joins mentions within the radius and separates distant ones", () => {
    const rows = [located({}), located({ url: "https://b.example.org/p", domain: "b.example.org", lat: 54.2009 }), located({ url: "https://c.example.org/p", domain: "c.example.org", lat: 54.218 })];
    const places = clusterLocated(rows, 300);
    expect(places).toHaveLength(2);
    expect(places[0]?.mentions).toHaveLength(2);
    expect(places[1]?.mentions).toHaveLength(1);
  });

  it("leaves unresolved mentions out", () => {
    expect(clusterLocated([located({ method: null, lon: null, lat: null, reason: "no_match" })], 300)).toHaveLength(0);
  });
});

describe("independentSources", () => {
  const shared = "the bay offers excellent shelter from the meltemi with good holding in sand at five metres";
  it("counts two domains with the same long quote as one source", () => {
    const rows = [located({ berthQuote: shared }), located({ url: "https://b.example.org/p", domain: "b.example.org", berthQuote: `${shared} and a taverna` })];
    expect(independentSources(rows, 12, false)).toBe(1);
  });
  it("counts two domains with different quotes as two sources", () => {
    const rows = [located({}), located({ url: "https://b.example.org/p", domain: "b.example.org", berthQuote: "a lovely spot, we dropped the hook in the north corner and swam ashore" })];
    expect(independentSources(rows, 12, false)).toBe(2);
  });
  it("in strict mode counts only first-hand pages and pilot guides", () => {
    const rows = [located({}), located({ url: "https://b.example.org/p", domain: "b.example.org", berthQuote: "a lovely spot, we dropped the hook in the north corner", firstHand: false, pageKind: "travel_guide" })];
    expect(independentSources(rows, 12, true)).toBe(1);
    expect(independentSources(rows, 12, false)).toBe(2);
  });
  it("counts two pages of one domain as one source", () => {
    const rows = [located({}), located({ url: "https://a.example.org/q", berthQuote: "a lovely spot, we dropped the hook in the north corner and swam ashore" })];
    expect(independentSources(rows, 12, false)).toBe(1);
  });
});
