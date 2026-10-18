import { describe, expect, it } from "vitest";
import { assertScratchUrl, compactOverpass, parseArgs } from "../fixtures-record";

describe("fixtures-record CLI", () => {
  it("parses flags", () => {
    expect(parseArgs(["--area", "aegina-west"])).toEqual({ area: "aegina-west", land: undefined, cache: undefined });
    expect(parseArgs(["--area", "a", "--land", "l.shp", "--cache", "/tmp/c"])).toEqual({ area: "a", land: "l.shp", cache: "/tmp/c" });
  });

  it("rejects missing or unknown arguments", () => {
    expect(() => parseArgs(["--land", "l.shp"])).toThrow(/usage/);
    expect(() => parseArgs(["--area", "a", "--foo", "1"])).toThrow(/usage/);
  });

  it("only writes to a *_scratch database", () => {
    expect(assertScratchUrl("postgres://u:p@localhost:5434/periplus_scratch")).toContain("periplus_scratch");
    expect(() => assertScratchUrl("postgres://u:p@localhost:5434/periplus_test")).toThrow(/_scratch/);
    expect(() => assertScratchUrl(undefined)).toThrow(/DATABASE_URL/);
  });
});

describe("compactOverpass", () => {
  // A ring of 12,000 points on a circle, split into two member ways of one relation.
  const ring = Array.from({ length: 12_001 }, (_, i) => {
    const a = ((i % 12_000) / 12_000) * 2 * Math.PI;
    return { lat: 37 + Math.sin(a), lon: 23 + Math.cos(a) };
  });
  const relation = {
    type: "relation",
    id: 1,
    tags: { place: "sea" },
    members: [
      { type: "way", ref: 10, role: "outer", geometry: ring.slice(0, 6_001) },
      { type: "way", ref: 11, role: "outer", geometry: ring.slice(6_000).reverse() },
      { type: "node", ref: 12, role: "label" },
    ],
  };
  const small = { type: "node", id: 2, lat: 37.5, lon: 23.5, tags: { natural: "cape" } };

  it("joins and thins the member ways of huge elements into a closed ring and leaves small ones alone", () => {
    const out = JSON.parse(compactOverpass(JSON.stringify({ elements: [relation, small] }))) as {
      elements: Array<{ members?: Array<{ type: string; role: string; geometry?: Array<{ lat: number; lon: number }> }> }>;
    };
    const [sea, cape] = out.elements;
    const ways = sea!.members!.filter((m) => m.type === "way");
    expect(ways).toHaveLength(1);
    const line = ways[0]!.geometry!;
    expect(line.length).toBeLessThan(500);
    expect(line[0]).toEqual(line.at(-1));
    expect(sea!.members!.some((m) => m.role === "label")).toBe(true);
    expect(cape).toEqual(small);
  });
});
