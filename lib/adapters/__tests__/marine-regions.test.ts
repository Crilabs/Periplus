import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { loadConfig } from "@/lib/config";
import { RetryableHttpError, makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import { fetchSeas, seasUrl } from "@/lib/adapters/marine-regions";

const db = testDb();
const config = loadConfig();
const ctx = { db, stage: "test" };
const cfg = config.gazetteer.marineRegions;
const mrgids = config.subdivisions.mediterranean.marineRegionsMrgids;

function textTransport(text: string, seen: HttpRequest[] = []): Transport {
  return async (req) => {
    seen.push(req);
    return makeResponse(200, new TextEncoder().encode(text));
  };
}

describe("seasUrl", () => {
  it("filters the IHO layer by mrgid and asks for GeoJSON", () => {
    const url = new URL(seasUrl(cfg.endpoint, [3314, 3315]));
    expect(url.origin + url.pathname).toBe(cfg.endpoint);
    expect(url.searchParams.get("typeNames")).toBe("MarineRegions:iho");
    expect(url.searchParams.get("outputFormat")).toBe("application/json");
    expect(url.searchParams.get("request")).toBe("GetFeature");
    expect(url.searchParams.get("CQL_FILTER")).toBe("mrgid IN (3314,3315)");
  });
});

describe("fetchSeas", () => {
  it("returns every configured MRGID with MultiPolygon geometry from the recorded fixture", async () => {
    const seas = await fetchSeas(fixtureTransport(), mrgids, ctx, cfg);
    expect(seas.map((s) => s.mrgid).sort((a, b) => a - b)).toEqual([...mrgids].sort((a, b) => a - b));
    for (const sea of seas) {
      expect(sea.geometry.type).toBe("MultiPolygon");
      expect(sea.geometry.coordinates.length).toBeGreaterThan(0);
      expect(sea.name.length).toBeGreaterThan(0);
    }
    expect(seas.find((s) => s.mrgid === 3315)?.name).toBe("Aegean Sea");
  });

  it("an HTML error body raises RetryableHttpError", async () => {
    await expect(fetchSeas(textTransport("<html>Service Unavailable</html>"), mrgids, ctx, cfg)).rejects.toBeInstanceOf(
      RetryableHttpError,
    );
  });

  it("valid JSON that is no feature collection raises RetryableHttpError", async () => {
    await expect(fetchSeas(textTransport('{"type":"ExceptionReport"}'), mrgids, ctx, cfg)).rejects.toBeInstanceOf(RetryableHttpError);
  });

  it("makes no request for no ids", async () => {
    const seen: HttpRequest[] = [];
    expect(await fetchSeas(textTransport("", seen), [], ctx, cfg)).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});
