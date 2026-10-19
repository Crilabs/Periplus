import { describe, expect, it } from "vitest";
import { areaByKey, getConfig } from "@/lib/config";
import { assertScratchUrl, compactOverpass, parseArgs, serpRecordingQueries } from "../fixtures-record";

describe("fixtures-record CLI", () => {
  it("parses flags", () => {
    expect(parseArgs(["--area", "aegina-west"])).toEqual({
      area: "aegina-west",
      land: undefined,
      cache: undefined,
      datasets: false,
      serp: false,
    });
    expect(parseArgs(["--area", "a", "--land", "l.shp", "--cache", "/tmp/c"])).toEqual({
      area: "a",
      land: "l.shp",
      cache: "/tmp/c",
      datasets: false,
      serp: false,
    });
  });

  it("--datasets is a flag without value, anywhere in the arguments", () => {
    expect(parseArgs(["--area", "aegina-west", "--datasets"])).toMatchObject({ area: "aegina-west", datasets: true });
    expect(parseArgs(["--datasets", "--area", "a", "--cache", "/tmp/c"])).toMatchObject({ area: "a", cache: "/tmp/c", datasets: true });
  });

  it("--serp records at most 3 searches and needs an area", () => {
    expect(parseArgs(["--serp", "--area", "saronic"])).toMatchObject({ area: "saronic", serp: true, limit: 3 });
    expect(parseArgs(["--serp", "--area", "saronic", "--limit", "1"])).toMatchObject({ serp: true, limit: 1 });
    expect(() => parseArgs(["--serp", "--area", "saronic", "--limit", "4"])).toThrow(/usage/);
    expect(() => parseArgs(["--serp", "--area", "saronic", "--limit", "0"])).toThrow(/usage/);
    expect(() => parseArgs(["--serp"])).toThrow(/usage/);
    expect(() => parseArgs(["--area", "saronic", "--limit", "2"])).toThrow(/usage/);
    expect(() => parseArgs(["--serp", "--datasets", "--area", "saronic"])).toThrow(/usage/);
  });

  it("--serp builds the area searches from the configured names", () => {
    const qs = serpRecordingQueries(areaByKey("saronic"), getConfig().discovery, 3);
    expect(qs).toEqual([
      { keyword: "Törnbericht Saronischer Golf", languageCode: "de", locationCode: 2276 },
      { keyword: "Revierführer Saronischer Golf", languageCode: "de", locationCode: 2276 },
      { keyword: "Saronic Gulf anchorages", languageCode: "en", locationCode: 2826 },
    ]);
    expect(serpRecordingQueries(areaByKey("saronic"), getConfig().discovery, 1)).toHaveLength(1);
    expect(serpRecordingQueries({ ...areaByKey("saronic"), sourceLanguages: ["en"] }, getConfig().discovery, 3)).toEqual([
      { keyword: "Saronic Gulf anchorages", languageCode: "en", locationCode: 2826 },
    ]);
  });

  it("--converters takes 1 to 3 page urls and no area", () => {
    expect(parseArgs(["--converters", "https://a.example/x", "http://b.example/"])).toEqual({
      converters: ["https://a.example/x", "http://b.example/"],
    });
    expect(() => parseArgs(["--converters"])).toThrow(/usage/);
    expect(() => parseArgs(["--converters", "https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4"])).toThrow(/usage/);
    expect(() => parseArgs(["--converters", "ftp://a.example/x"])).toThrow(/usage/);
    expect(() => parseArgs(["--converters", "https://a.example/x", "--area", "saronic"])).toThrow(/usage/);
    expect(() => parseArgs(["--area", "saronic", "--converters", "https://a.example/x"])).toThrow(/usage/);
  });

  it("rejects missing or unknown arguments", () => {
    expect(() => parseArgs(["--land", "l.shp"])).toThrow(/usage/);
    expect(() => parseArgs(["--area", "a", "--foo", "1"])).toThrow(/usage/);
    expect(() => parseArgs(["--area", "--datasets"])).toThrow(/usage/);
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
