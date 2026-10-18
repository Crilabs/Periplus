import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { newId } from "@/lib/domain/ids";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { buildWikidataQuery, wikidataQuery } from "@/lib/adapters/wikidata";

const db = testDb();

const cfg = () => ({
  endpoint: `https://wdqs.example.invalid/${newId()}/sparql`,
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
