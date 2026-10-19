import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb, withRollback } from "@/test/db";
import { externalCalls } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { HttpError, makeResponse, RetryableHttpError, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { buildWikidataQuery, fetchSitelinks, sitelinkCounts, wikidataQuery } from "@/lib/adapters/wikidata";

const db = testDb();

const cfg = () => ({
  endpoint: `https://wdqs.example.invalid/${newId()}/sparql`,
  apiEndpoint: `https://wikidata.example.invalid/${newId()}/w/api.php`,
  languages: ["de", "en", "el"],
  classes: { Q23442: "island" as const },
  ratePerMinute: 1_000_000,
});

const uri = (q: string) => ({ type: "uri", value: `http://www.wikidata.org/entity/${q}` });
const lit = (value: string) => ({ type: "literal", value });
const bool = (b: boolean) => ({ type: "literal", datatype: "http://www.w3.org/2001/XMLSchema#boolean", value: String(b) });
const point = (lon: number, lat: number) => ({
  type: "literal",
  datatype: "http://www.opengis.net/ont/geosparql#wktLiteral",
  value: `Point(${lon} ${lat})`,
});

describe("buildWikidataQuery", () => {
  it("builds a box query with classes, languages and the OSM relation", () => {
    const q = buildWikidataQuery([23.0, 37.5, 23.25, 37.75], ["Q23442", "Q39594"], ["de", "en"]);
    expect(q).toContain("SERVICE wikibase:box");
    expect(q).toContain('wikibase:cornerSouthWest "Point(23 37.5)"^^geo:wktLiteral');
    expect(q).toContain('wikibase:cornerNorthEast "Point(23.25 37.75)"^^geo:wktLiteral');
    expect(q).toContain("VALUES ?class { wd:Q23442 wd:Q39594 }");
    expect(q).toContain("?item wdt:P31/wdt:P279* ?class");
    expect(q).toContain('IN ("de", "en")');
    expect(q).toContain("wdt:P402 ?osmRel");
  });

  it("rejects a malformed class id", () => {
    expect(() => buildWikidataQuery([23, 37, 24, 38], ["Q1 } DELETE"], ["de"])).toThrow();
  });
});

describe("wikidataQuery", () => {
  it("wikidataQuery groups labels and aliases per item", async () => {
    const rows = [
      { item: uri("Q1"), class: uri("Q23442"), coord: point(23.42, 37.74), name: lit("Ägina"), lang: lit("de"), isAlias: bool(false), osmRel: lit("1234") },
      { item: uri("Q1"), class: uri("Q23442"), coord: point(23.42, 37.74), name: lit("Aegina"), lang: lit("en"), isAlias: bool(false), osmRel: lit("1234") },
      { item: uri("Q1"), class: uri("Q23442"), coord: point(23.42, 37.74), name: lit("Egina"), lang: lit("en"), isAlias: bool(true), osmRel: lit("1234") },
      { item: uri("Q1"), class: uri("Q33837"), coord: point(23.42, 37.74), name: lit("Ägina"), lang: lit("de"), isAlias: bool(false), osmRel: lit("1234") },
      { item: uri("Q2"), class: uri("Q39594"), coord: point(23.5, 37.6) },
    ];
    const seen: HttpRequest[] = [];
    const transport: Transport = async (req) => {
      seen.push(req);
      return makeResponse(200, new TextEncoder().encode(JSON.stringify({ head: { vars: [] }, results: { bindings: rows } })));
    };
    const c = cfg();
    const items = await wikidataQuery(transport, "SELECT 1", { db }, c);

    expect(seen[0]?.method ?? "GET").toBe("GET");
    expect(seen[0]?.url).toBe(`${c.endpoint}?format=json&query=${encodeURIComponent("SELECT 1")}`);
    expect(items).toEqual([
      {
        id: "Q1",
        classes: ["Q23442", "Q33837"],
        lon: 23.42,
        lat: 37.74,
        labels: [
          { language: "de", value: "Ägina", alias: false },
          { language: "en", value: "Aegina", alias: false },
          { language: "en", value: "Egina", alias: true },
        ],
        osmRelationId: "1234",
      },
      { id: "Q2", classes: ["Q39594"], lon: 23.5, lat: 37.6, labels: [] },
    ]);
  });
});

describe("fetchSitelinks", () => {
  /** Answers each request with `answer(ids)` and keeps the requests. */
  function api(answer: (ids: string[]) => unknown): Transport & { requests: HttpRequest[] } {
    const requests: HttpRequest[] = [];
    const transport = async (req: HttpRequest) => {
      requests.push(req);
      const ids = new URL(req.url).searchParams.get("ids")!.split("|");
      return makeResponse(200, new TextEncoder().encode(JSON.stringify(answer(ids))));
    };
    return Object.assign(transport, { requests });
  }

  const link = (site: string, title: string) => ({ site, title, badges: [], url: `https://${site.slice(0, 2)}.wikivoyage.org/wiki/${title}` });

  it("asks for sorted ids and sites in batches of 50 and keeps only the asked sites", async () => {
    await withRollback(async (tx) => {
      const qids = Array.from({ length: 51 }, (_, i) => `Q${100 + i}`).reverse();
      const transport = api((ids) => ({
        entities: Object.fromEntries(
          ids.map((id) => [
            id,
            id === "Q100"
              ? { type: "item", id, sitelinks: { enwikivoyage: link("enwikivoyage", "Alpha"), dewiki: link("dewiki", "Alpha"), dewikivoyage: link("dewikivoyage", "Alpha") } }
              : { type: "item", id, sitelinks: {} },
          ]),
        ),
      }));
      const c = cfg();
      const links = await fetchSitelinks(transport, qids, ["enwikivoyage", "dewikivoyage"], { db: tx }, c);

      expect(transport.requests.map((r) => r.url)).toEqual([
        `${c.apiEndpoint}?action=wbgetentities&ids=${qids.slice(1).reverse().join("|")}&props=sitelinks/urls&sitefilter=dewikivoyage|enwikivoyage&format=json`,
        `${c.apiEndpoint}?action=wbgetentities&ids=Q150&props=sitelinks/urls&sitefilter=dewikivoyage|enwikivoyage&format=json`,
      ]);
      expect([...links.keys()]).toEqual(["Q100"]);
      expect(links.get("Q100")).toEqual([
        { site: "dewikivoyage", title: "Alpha", url: "https://de.wikivoyage.org/wiki/Alpha" },
        { site: "enwikivoyage", title: "Alpha", url: "https://en.wikivoyage.org/wiki/Alpha" },
      ]);
    });
  });

  it("skips missing items, retries on maxlag and fails on other API errors", async () => {
    await withRollback(async (tx) => {
      const missing = api((ids) => ({ entities: { [ids[0]!]: { id: ids[0], missing: "" } } }));
      expect((await fetchSitelinks(missing, ["Q1"], ["enwikivoyage"], { db: tx }, cfg())).size).toBe(0);
      const lagging = api(() => ({ error: { code: "maxlag", info: "Waiting for a database server" } }));
      await expect(fetchSitelinks(lagging, ["Q1"], ["enwikivoyage"], { db: tx }, cfg())).rejects.toBeInstanceOf(RetryableHttpError);
      const wrong = api(() => ({ error: { code: "no-such-entity", info: "Could not find an entity" } }));
      await expect(fetchSitelinks(wrong, ["Q1"], ["enwikivoyage"], { db: tx }, cfg())).rejects.toBeInstanceOf(HttpError);
      await expect(fetchSitelinks(missing, ["P31"], ["enwikivoyage"], { db: tx }, cfg())).rejects.toThrow(/invalid Wikidata item/);
    });
  });
});

describe("sitelinkCounts", () => {
  function api(answer: (ids: string[]) => unknown): Transport & { requests: HttpRequest[] } {
    const requests: HttpRequest[] = [];
    const transport = async (req: HttpRequest) => {
      requests.push(req);
      const ids = new URL(req.url).searchParams.get("ids")!.split("|");
      return makeResponse(200, new TextEncoder().encode(JSON.stringify(answer(ids))));
    };
    return Object.assign(transport, { requests });
  }
  const links = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`wiki${i}`, { site: `wiki${i}`, title: "T", badges: [] }]));

  it("sitelinks are batched by 50 ids, counting every wiki, one external call per request (ruling M5-P1)", () =>
    withRollback(async (tx) => {
      const qids = Array.from({ length: 120 }, (_, i) => `Q${1000 + i}`).reverse();
      const transport = api((ids) => ({
        entities: Object.fromEntries(ids.map((id) => [id, { type: "item", id, sitelinks: links(Number(id.slice(1)) % 7) }])),
      }));
      const c = cfg();
      const runId = newId();
      const counts = await sitelinkCounts(transport, [...qids, "Q1000"], { db: tx, runId, stage: "datasets.import" }, c);

      const sorted = [...qids].sort();
      expect(transport.requests.map((r) => r.url)).toEqual(
        [sorted.slice(0, 50), sorted.slice(50, 100), sorted.slice(100)].map(
          (batch) => `${c.apiEndpoint}?action=wbgetentities&ids=${batch.join("|")}&props=sitelinks&format=json`,
        ),
      );
      expect(counts.size).toBe(120);
      expect(counts.get("Q1000")).toBe(1000 % 7);
      expect(counts.get("Q1119")).toBe(1119 % 7);
      const calls = await tx.select().from(externalCalls).where(eq(externalCalls.runId, runId));
      expect(calls.map((r) => [r.service, r.operation, r.stage])).toEqual(Array(3).fill(["wikidata", "sitelink_counts", "datasets.import"]));
    }));

  it("a missing item is absent, a redirected one counts under the asked id, an item without links counts 0", () =>
    withRollback(async (tx) => {
      const transport = api(() => ({
        entities: {
          Q1: { id: "Q1", missing: "" },
          Q20: { type: "item", id: "Q20", redirects: { from: "Q2", to: "Q20" }, sitelinks: links(3) },
          Q3: { type: "item", id: "Q3" },
        },
      }));
      const counts = await sitelinkCounts(transport, ["Q1", "Q2", "Q3"], { db: tx }, cfg());
      expect([...counts.entries()].sort()).toEqual([["Q2", 3], ["Q3", 0]]);
      await expect(sitelinkCounts(transport, ["P31"], { db: tx }, cfg())).rejects.toThrow(/invalid Wikidata item/);
      const lagging = api(() => ({ error: { code: "maxlag", info: "lag" } }));
      await expect(sitelinkCounts(lagging, ["Q1"], { db: tx }, cfg())).rejects.toBeInstanceOf(RetryableHttpError);
      expect(await sitelinkCounts(transport, [], { db: tx }, cfg())).toEqual(new Map());
    }));
});
