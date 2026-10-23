import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import type { GazetteerConfig } from "@/lib/config";
import { newId } from "@/lib/domain/ids";
import { countryBlocks } from "@/lib/domain/gazetteer/land";
import { RetryableHttpError, makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { buildGazetteerQuery, overpassQuery, overpassQueryRetrying } from "@/lib/adapters/overpass";

const db = testDb();

function jsonTransport(payload: unknown, seen: HttpRequest[] = []): Transport {
  return async (req) => {
    seen.push(req);
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    return makeResponse(200, new TextEncoder().encode(text));
  };
}

// The rate-limit bucket "http:overpass" is shared across tests; a huge rate keeps it from ever blocking.
const cfg = (): GazetteerConfig["overpass"] => ({
  endpoint: `https://overpass.example.invalid/${newId()}`,
  timeoutSeconds: 180,
  maxRelationPoints: 250_000,
  ratePerMinute: 1_000_000,
  retries: 4,
  retryDelaySeconds: 60,
  blockDeg: 2,
  minBlockDeg: 0.5,
});

describe("buildGazetteerQuery", () => {
  it("buildGazetteerQuery puts the bbox in south,west,north,east order and asks for the skeleton only", () => {
    const ql = buildGazetteerQuery([23.0, 37.5, 23.25, 37.75], 180);
    expect(ql.startsWith("[out:json][timeout:180];")).toBe(true);
    expect(ql).toContain('relation["place"="gulf"](37.5,23,37.75,23.25);');
    expect(ql).toContain('relation["natural"="bay"](37.5,23,37.75,23.25);');
    expect(ql).toContain('way["natural"="bay"](37.5,23,37.75,23.25);');
    expect(ql).toContain('nwr["place"~"^(island|islet|archipelago)$"](37.5,23,37.75,23.25);');
    expect(ql).toContain('node["place"~"^(town|village|hamlet)$"](37.5,23,37.75,23.25);');
    expect(ql).toContain('nwr["natural"~"^(bay|cape|strait)$"](37.5,23,37.75,23.25);');
    expect(ql).toContain('nwr["leisure"="marina"](37.5,23,37.75,23.25);');
    expect(ql).toContain('nwr["seamark:type"~"^(harbour|anchorage|mooring|small_craft_facility)$"](37.5,23,37.75,23.25);');
    expect(ql).toContain('nwr["harbour"](37.5,23,37.75,23.25);');
    // No seas (Marine Regions), no peninsulas (coast sections come from config), no POI category rules (B5, B6, B8).
    expect(ql).not.toContain("peninsula");
    expect(ql).not.toContain('place"~"sea');
    expect(ql).not.toContain("amenity");
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

describe("overpassQueryRetrying", () => {
  const ok = JSON.stringify({ elements: [{ type: "node", id: 1, lat: 1, lon: 2 }] });
  const failing = (statuses: number[], seen: number[] = []): Transport => async () => {
    const status = statuses[seen.length] ?? 200;
    seen.push(status);
    return makeResponse(status, new TextEncoder().encode(status === 200 ? ok : "busy"));
  };

  it("repeats after 502 with a doubling wait and returns the answer", async () => {
    const seen: number[] = [];
    const sleeps: number[] = [];
    const res = await overpassQueryRetrying(failing([502, 502], seen), "x", { db }, cfg(), { sleep: async (ms) => void sleeps.push(ms) });
    expect(res.elements).toHaveLength(1);
    expect(seen).toHaveLength(3);
    expect(sleeps).toEqual([60_000, 120_000]);
  });

  it("names the part after the last attempt", async () => {
    const seen: number[] = [];
    const error: unknown = await overpassQueryRetrying(failing([502, 502, 502, 502, 502], seen), "x", { db }, cfg(), {
      sleep: async () => {},
      part: "islands#3",
    }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/overpass part islands#3 failed after 5 attempts/);
    // still retryable: a later job attempt may find the server free
    expect(error).toBeInstanceOf(RetryableHttpError);
    expect(seen).toHaveLength(5);
  });

  it("repeats a remark with a runtime error", async () => {
    const remark = JSON.stringify({ elements: [], remark: "runtime error: Query timed out" });
    let calls = 0;
    const transport: Transport = async () => makeResponse(200, new TextEncoder().encode(calls++ === 0 ? remark : ok));
    expect((await overpassQueryRetrying(transport, "x", { db }, cfg(), { sleep: async () => {} })).elements).toHaveLength(1);
  });

  it("does not repeat an error that is not retryable", async () => {
    const seen: number[] = [];
    await expect(overpassQueryRetrying(failing([400], seen), "x", { db }, cfg(), { sleep: async () => {} })).rejects.not.toBeInstanceOf(RetryableHttpError);
    expect(seen).toHaveLength(1);
  });
});

describe("countryBlocks", () => {
  it("covers [19, 34, 29, 42] with 5 x 4 blocks of 2 degrees", () => {
    const blocks = countryBlocks([19, 34, 29, 42], 2);
    expect(blocks).toHaveLength(20);
    expect(Math.min(...blocks.map((b) => b[0]))).toBe(19);
    expect(Math.min(...blocks.map((b) => b[1]))).toBe(34);
    expect(Math.max(...blocks.map((b) => b[2]))).toBe(29);
    expect(Math.max(...blocks.map((b) => b[3]))).toBe(42);
    expect(blocks.reduce((sum, [w, s, e, n]) => sum + (e - w) * (n - s), 0)).toBe(80);
  });

  it("ends the last block at the box edge and gives a small box one block", () => {
    expect(countryBlocks([14, 35.7, 15.1, 36.2], 2)).toEqual([[14, 35.7, 15.1, 36.2]]);
    expect(countryBlocks([0, 0, 3, 1], 2)).toEqual([[0, 0, 2, 1], [2, 0, 3, 1]]);
  });
});
