import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { loadConfig } from "@/lib/config";
import { RetryableHttpError, makeResponse, type Transport } from "@/lib/adapters/http";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import { buildBoundaryQuery, buildRelationQuery, overpassQuery } from "@/lib/adapters/overpass";

const db = testDb();
const config = loadConfig();
const ctx = { db, stage: "test" };
// The bucket "http:overpass" is shared across tests; a huge rate keeps it from ever blocking.
const cfg = { ...config.gazetteer.overpass, ratePerMinute: 1_000_000 };

describe("buildBoundaryQuery", () => {
  it("asks for the configured level inside the country area and for the country relation", () => {
    const ql = buildBoundaryQuery("HR", [4], 180);
    expect(ql.startsWith("[out:json][timeout:180];")).toBe(true);
    expect(ql).toContain('area["ISO3166-1"="HR"][admin_level=2]->.c;');
    expect(ql).toContain('relation[boundary=administrative][admin_level~"^(4)$"](area.c);');
    expect(ql).toContain('relation["ISO3166-1"="HR"][admin_level=2][boundary=administrative];');
    expect(ql.trimEnd().endsWith("out geom;")).toBe(true);
  });

  it("joins several levels into one alternation", () => {
    expect(buildBoundaryQuery("GR", [4, 5], 60)).toContain('admin_level~"^(4|5)$"');
  });

  it("without levels queries the country relation only", () => {
    const ql = buildBoundaryQuery("MT", [], 180);
    expect(ql).not.toContain("area");
    expect(ql).toContain('relation["ISO3166-1"="MT"][admin_level=2][boundary=administrative];');
  });
});

describe("buildRelationQuery", () => {
  it("lists the relation ids", () => {
    expect(buildRelationQuery([2514541, 12], 90)).toBe("[out:json][timeout:90];\nrelation(id:2514541,12);\nout geom;\n");
  });
});

describe("recorded boundary fixtures", () => {
  it("HR: 21 level-4 counties with ISO3166-2 tags plus the country relation", async () => {
    const ql = buildBoundaryQuery("HR", [4], config.gazetteer.overpass.timeoutSeconds);
    const { elements } = await overpassQuery(fixtureTransport(), ql, ctx, cfg);
    const counties = elements.filter((e) => e.type === "relation" && e.tags?.admin_level === "4" && e.tags["ISO3166-2"]?.startsWith("HR-"));
    expect(counties).toHaveLength(21);
    expect(counties.map((e) => e.tags!["ISO3166-2"])).toContain("HR-17");
    expect(elements.find((e) => e.tags?.admin_level === "2")?.tags?.name).toBe("Hrvatska");
    expect(counties.every((e) => e.members?.some((m) => m.geometry?.length))).toBe(true);
  });

  it("MT: the country relation", async () => {
    const ql = buildBoundaryQuery("MT", [], config.gazetteer.overpass.timeoutSeconds);
    const { elements } = await overpassQuery(fixtureTransport(), ql, ctx, cfg);
    expect(elements).toHaveLength(1);
    expect(elements[0]!.tags?.admin_level).toBe("2");
  });
});

describe("overpassQuery on boundary queries", () => {
  it("an HTML error body raises RetryableHttpError", async () => {
    const html: Transport = async () => makeResponse(200, new TextEncoder().encode("<html><body>Too busy</body></html>"));
    await expect(overpassQuery(html, buildBoundaryQuery("HR", [4], 180), ctx, cfg)).rejects.toBeInstanceOf(RetryableHttpError);
  });
});
