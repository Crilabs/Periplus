import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { loadConfig } from "@/lib/config";
import { newId } from "@/lib/domain/ids";
import { RetryableHttpError, makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { buildGazetteerQuery, overpassQuery } from "@/lib/adapters/overpass";

const db = testDb();
const config = loadConfig();

function jsonTransport(payload: unknown, seen: HttpRequest[] = []): Transport {
  return async (req) => {
    seen.push(req);
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    return makeResponse(200, new TextEncoder().encode(text));
  };
}

// The rate-limit bucket "http:overpass" is shared across tests; a huge rate keeps it from ever blocking.
const cfg = (): typeof config.gazetteer.overpass => ({
  endpoint: `https://overpass.example.invalid/${newId()}`,
  timeoutSeconds: 180,
  ratePerMinute: 1_000_000,
});

describe("buildGazetteerQuery", () => {
  it("buildGazetteerQuery puts the bbox in south,west,north,east order and includes every category rule", () => {
    const ql = buildGazetteerQuery([23.0, 37.5, 23.25, 37.75], config.categories, 180);
    expect(ql.startsWith("[out:json][timeout:180];")).toBe(true);
    expect(ql).toContain('relation["place"~"sea|gulf"](37.5,23,37.75,23.25);');
    expect(ql).toContain('relation["natural"="bay"](37.5,23,37.75,23.25);');
    expect(ql).toContain('way["natural"="bay"](37.5,23,37.75,23.25);');
    expect(ql).toContain('nwr["place"~"^(island|islet|archipelago)$"](37.5,23,37.75,23.25);');
    expect(ql).toContain('node["place"~"^(town|village|hamlet)$"](37.5,23,37.75,23.25);');
    expect(ql).toContain('nwr["natural"~"^(bay|cape|strait|peninsula)$"](37.5,23,37.75,23.25);');
    expect(ql).toContain('nwr["leisure"="marina"](37.5,23,37.75,23.25);');
    expect(ql).toContain('nwr["seamark:type"~"^(harbour|anchorage|mooring|small_craft_facility)$"](37.5,23,37.75,23.25);');
    expect(ql).toContain('nwr["harbour"](37.5,23,37.75,23.25);');
    for (const rule of config.categories.osm) {
      const filter = rule.values === "*" ? `["${rule.key}"]` : `["${rule.key}"~"^(${rule.values.join("|")})$"]`;
      expect(ql).toContain(`nwr${filter}["name"](37.5,23,37.75,23.25);`);
    }
    expect(ql.trimEnd().endsWith("\nout geom;")).toBe(true);
  });
});

describe("overpassQuery", () => {
  it("posts the query as form data and returns raw text and elements", async () => {
    const seen: HttpRequest[] = [];
    const payload = { elements: [{ type: "node", id: 1, lat: 37.6, lon: 23.1, tags: { name: "Perdika" } }] };
    const res = await overpassQuery(jsonTransport(payload, seen), "[out:json];node(1);out;", { db }, cfg());
    expect(res.elements).toEqual(payload.elements);
    expect(res.raw).toBe(JSON.stringify(payload));
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toBe(`data=${encodeURIComponent("[out:json];node(1);out;")}`);
    expect(seen[0]?.service).toBe("overpass");
  });

  it("overpass runtime-error remark is retryable", async () => {
    const payload = { elements: [], remark: "runtime error: Query timed out in \"query\" at line 3 after 180 seconds." };
    await expect(overpassQuery(jsonTransport(payload), "x", { db }, cfg())).rejects.toBeInstanceOf(RetryableHttpError);
  });

  it("invalid JSON is retryable", async () => {
    await expect(overpassQuery(jsonTransport("<html>busy</html>"), "x", { db }, cfg())).rejects.toBeInstanceOf(
      RetryableHttpError,
    );
  });
});
