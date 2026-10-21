import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureKey, loadAiFixtures } from "@/lib/ai/fixtures";
import { MockModel } from "@/lib/ai/mock";
import { echoTask } from "@/lib/ai/tasks/system-echo";
import type { ModelTask } from "@/lib/ai/types";
import { getConfig } from "@/lib/config";
import { assertScratchUrl, compactOverpass, parseArgs, recordAiAnswers, serpRecordingQueries } from "../fixtures-record";

describe("fixtures-record CLI", () => {
  it("parses flags", () => {
    expect(parseArgs(["--subdivision", "aegina-west"])).toEqual({
      subdivision: "aegina-west",
      land: undefined,
      cache: undefined,
      datasets: false,
      serp: false,
    });
    expect(parseArgs(["--subdivision", "a", "--land", "l.shp", "--cache", "/tmp/c"])).toEqual({
      subdivision: "a",
      land: "l.shp",
      cache: "/tmp/c",
      datasets: false,
      serp: false,
    });
  });

  it("--datasets is a flag without value, anywhere in the arguments", () => {
    expect(parseArgs(["--subdivision", "aegina-west", "--datasets"])).toMatchObject({ subdivision: "aegina-west", datasets: true });
    expect(parseArgs(["--datasets", "--subdivision", "a", "--cache", "/tmp/c"])).toMatchObject({ subdivision: "a", cache: "/tmp/c", datasets: true });
    expect(parseArgs(["--subdivision", "a", "--datasets"])).not.toHaveProperty("datasetKinds");
  });

  it("--datasets takes an optional list of dataset kinds", () => {
    expect(parseArgs(["--subdivision", "aegina-west", "--datasets", "sitelinks"])).toMatchObject({ datasets: true, datasetKinds: ["sitelinks"] });
    expect(parseArgs(["--datasets", "roads,sitelinks", "--subdivision", "a"])).toMatchObject({ subdivision: "a", datasetKinds: ["roads", "sitelinks"] });
    expect(() => parseArgs(["--subdivision", "a", "--datasets", "tides"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "a", "--datasets", "roads,roads"])).toThrow(/usage/);
  });

  it("--serp records at most 3 searches and needs a subdivision", () => {
    expect(parseArgs(["--serp", "--subdivision", "saronic"])).toMatchObject({ subdivision: "saronic", serp: true, limit: 3 });
    expect(parseArgs(["--serp", "--subdivision", "saronic", "--limit", "1"])).toMatchObject({ serp: true, limit: 1 });
    expect(() => parseArgs(["--serp", "--subdivision", "saronic", "--limit", "4"])).toThrow(/usage/);
    expect(() => parseArgs(["--serp", "--subdivision", "saronic", "--limit", "0"])).toThrow(/usage/);
    expect(() => parseArgs(["--serp"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "saronic", "--limit", "2"])).toThrow(/usage/);
    expect(() => parseArgs(["--serp", "--datasets", "--subdivision", "saronic"])).toThrow(/usage/);
  });

  it("--serp builds the area searches from the names of the subdivision's region", () => {
    const saronic = { names: { de: "Saronischer Golf", en: "Saronic Gulf", el: "Σαρωνικός" }, sourceLanguages: ["de", "en", "el"] };
    const qs = serpRecordingQueries(saronic, getConfig().discovery, 3);
    expect(qs).toEqual([
      { keyword: "Törnbericht Saronischer Golf", languageCode: "de", locationCode: 2276 },
      { keyword: "Revierführer Saronischer Golf", languageCode: "de", locationCode: 2276 },
      { keyword: "Saronic Gulf anchorages", languageCode: "en", locationCode: 2826 },
    ]);
    expect(serpRecordingQueries(saronic, getConfig().discovery, 1)).toHaveLength(1);
    expect(serpRecordingQueries({ ...saronic, sourceLanguages: ["en"] }, getConfig().discovery, 3)).toEqual([
      { keyword: "Saronic Gulf anchorages", languageCode: "en", locationCode: 2826 },
    ]);
  });

  it("--converters takes 1 to 3 page urls and no subdivision", () => {
    expect(parseArgs(["--converters", "https://a.example/x", "http://b.example/"])).toEqual({
      converters: ["https://a.example/x", "http://b.example/"],
    });
    expect(() => parseArgs(["--converters"])).toThrow(/usage/);
    expect(() => parseArgs(["--converters", "https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4"])).toThrow(/usage/);
    expect(() => parseArgs(["--converters", "ftp://a.example/x"])).toThrow(/usage/);
    expect(() => parseArgs(["--converters", "https://a.example/x", "--subdivision", "saronic"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "saronic", "--converters", "https://a.example/x"])).toThrow(/usage/);
  });

  it("--voyage stands alone", () => {
    expect(parseArgs(["--voyage"])).toEqual({ voyage: true });
    expect(() => parseArgs(["--voyage", "--subdivision", "saronic"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "saronic", "--voyage"])).toThrow(/usage/);
  });

  it("--nominatim takes a query and a tile id and stands alone", () => {
    expect(parseArgs(["--nominatim", "Kolona", "q025:813:510"])).toEqual({ nominatim: { query: "Kolona", tileId: "q025:813:510" } });
    expect(() => parseArgs(["--nominatim", "Kolona"])).toThrow(/usage/);
    expect(() => parseArgs(["--nominatim", "Kolona", "813:510"])).toThrow(/usage/);
    expect(() => parseArgs(["--nominatim", " ", "q025:813:510"])).toThrow(/usage/);
    expect(() => parseArgs(["--nominatim", "Kolona", "q025:813:510", "--subdivision", "saronic"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "saronic", "--nominatim", "Kolona", "q025:813:510"])).toThrow(/usage/);
  });

  it("--imagery takes a longitude and a latitude and stands alone", () => {
    expect(parseArgs(["--imagery", "22.995", "37.49"])).toEqual({ imagery: { lon: 22.995, lat: 37.49 } });
    expect(() => parseArgs(["--imagery", "22.995"])).toThrow(/usage/);
    expect(() => parseArgs(["--imagery", "east", "37.49"])).toThrow(/usage/);
    expect(() => parseArgs(["--imagery", "200", "37.49"])).toThrow(/usage/);
    expect(() => parseArgs(["--imagery", "22.995", "95"])).toThrow(/usage/);
    expect(() => parseArgs(["--imagery", "22.995", "37.49", "--subdivision", "saronic"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "saronic", "--imagery", "22.995", "37.49"])).toThrow(/usage/);
  });

  it("--ai takes a model task, at most 5 answers and a cost ceiling, and stands alone", () => {
    expect(parseArgs(["--ai", "extract-facts"])).toEqual({ ai: { task: "extract-facts", limit: 5, maxEur: 1 } });
    expect(parseArgs(["--ai", "extract-facts", "--limit", "5", "--max-eur", "1"])).toEqual({ ai: { task: "extract-facts", limit: 5, maxEur: 1 } });
    expect(parseArgs(["--ai", "classify-document", "--max-eur", "0.2", "--limit", "2"])).toEqual({ ai: { task: "classify-document", limit: 2, maxEur: 0.2 } });
    for (const task of ["disambiguate-mention", "extract-route"]) expect(parseArgs(["--ai", task])).toMatchObject({ ai: { task } });
    for (const argv of [
      ["--ai"],
      ["--ai", "pdf.to_markdown"],
      ["--ai", "extract-facts", "--limit", "6"],
      ["--ai", "extract-facts", "--limit", "0"],
      ["--ai", "extract-facts", "--max-eur", "0"],
      ["--ai", "extract-facts", "--max-eur"],
      ["--ai", "extract-facts", "--limit", "2", "--limit", "3"],
      ["--ai", "extract-facts", "--subdivision", "saronic"],
      ["--subdivision", "saronic", "--ai", "extract-facts"],
    ]) {
      expect(() => parseArgs(argv)).toThrow(/usage/);
    }
  });

  it("--ai writes sanitized answers and stops at the cost ceiling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "periplus-ai-"));
    try {
      const task = echoTask as ModelTask<unknown, unknown>;
      const model = new MockModel({ "system.echo": (input) => ({ echo: (input as { text: string }).text, language: "en" }) });
      const inputs = [{ text: "eins" }, { text: "zwei" }, { text: "drei" }];
      // each call books 0.4 EUR (MockModel books nothing, so the client is wrapped)
      const client = { ...model, call: async (t: ModelTask<unknown, unknown>, i: unknown) => ({ ...(await model.call(t, i)), costEur: 0.4 }) } as unknown as MockModel;
      const result = await recordAiAnswers(task, inputs, { client, maxEur: 1, estimateEur: () => 0.3, dir, now: () => new Date("2026-10-19T08:00:00Z") });
      // after two answers 0.8 EUR are spent: a third (estimate 0.3) would pass 1 EUR
      expect(result).toMatchObject({ spentEur: 0.8, stopped: true });
      expect(result.recorded).toHaveLength(2);
      const files = await readdir(join(dir, "system.echo"));
      expect(files.sort()).toEqual([`${fixtureKey("system.echo", inputs[0])}.json`, `${fixtureKey("system.echo", inputs[1])}.json`].sort());
      const stored = JSON.parse(await readFile(join(dir, "system.echo", files[0]!), "utf8")) as Record<string, unknown>;
      expect(Object.keys(stored).sort()).toEqual(["input", "key", "model", "output", "recordedAt", "task"]);
      expect(stored.recordedAt).toBe("2026-10-19T08:00:00.000Z");
      // the files load as MockModel fixtures
      expect(loadAiFixtures(dir)["system.echo"]!({ text: "zwei" })).toEqual({ echo: "zwei", language: "en" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("--wikivoyage needs a subdivision and excludes the other recordings", () => {
    expect(parseArgs(["--wikivoyage", "--subdivision", "saronic"])).toEqual({
      subdivision: "saronic",
      land: undefined,
      cache: undefined,
      datasets: false,
      serp: false,
      wikivoyage: true,
    });
    expect(() => parseArgs(["--wikivoyage"])).toThrow(/usage/);
    expect(() => parseArgs(["--wikivoyage", "--serp", "--subdivision", "saronic"])).toThrow(/usage/);
    expect(() => parseArgs(["--wikivoyage", "--datasets", "--subdivision", "saronic"])).toThrow(/usage/);
  });

  it("rejects missing or unknown arguments", () => {
    expect(() => parseArgs(["--land", "l.shp"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "a", "--foo", "1"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "--datasets"])).toThrow(/usage/);
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
