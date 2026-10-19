import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import type { DatasetsConfig } from "@/lib/config";
import { externalCalls } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import type { Bbox } from "@/lib/domain/tiles";
import { HttpError, RetryableHttpError, makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { coverageUrl, fetchCoverage, fetchWfsFeatures, wfsPageUrl } from "@/lib/adapters/emodnet";

const db = testDb();

/** Synthetic box around 21.0 E / 35.2 N (outside the pilot box). */
const BOX: Bbox = [20.9, 35.1, 21.1, 35.3];

// Unique endpoints per test keep the shared rate-limit buckets apart; the huge rate never blocks.
const bathymetryCfg = (): DatasetsConfig["bathymetry"] => ({
  wcsUrl: `https://wcs.example.invalid/${newId()}/wcs`,
  coverageId: "emodnet__mean",
  dataset: "emodnet-dtm",
  datasetVersion: "2024",
  resolutionM: 115,
  valueIsElevation: true,
  timeoutSeconds: 120,
  ratePerMinute: 1_000_000,
});

const wfsInput = (pageSize: number) => ({
  service: "emodnet-seabed",
  url: `https://wfs.example.invalid/${newId()}/wfs`,
  typeName: "emodnet_open:eusm2025_eunis2019_full",
  bbox: BOX,
  pageSize,
  timeoutMs: 180_000,
  ratePerMinute: 1_000_000,
});

const encode = (text: string) => new TextEncoder().encode(text);

/** Answers each request with the next body in `bodies` (the last one repeats) and remembers the requests. */
function scriptedTransport(bodies: Array<string | Uint8Array>, seen: HttpRequest[] = []): Transport {
  return async (req) => {
    const body = bodies[Math.min(seen.length, bodies.length - 1)]!;
    seen.push(req);
    return makeResponse(200, typeof body === "string" ? encode(body) : body);
  };
}

function featureCollection(count: number, offset = 0): string {
  return JSON.stringify({
    type: "FeatureCollection",
    features: Array.from({ length: count }, (_, i) => ({
      type: "Feature",
      id: `f.${offset + i}`,
      properties: { substrate: "Sand" },
      geometry: { type: "Point", coordinates: [21, 35.2] },
    })),
  });
}

describe("coverageUrl", () => {
  it("coverageUrl puts lon into Long() and lat into Lat()", () => {
    const cfg = bathymetryCfg();
    const url = new URL(coverageUrl(cfg, BOX));
    expect(url.origin + url.pathname).toBe(cfg.wcsUrl);
    const p = url.searchParams;
    expect(p.get("service")).toBe("WCS");
    expect(p.get("version")).toBe("2.0.1");
    expect(p.get("request")).toBe("GetCoverage");
    expect(p.get("coverageId")).toBe("emodnet__mean");
    expect(p.get("format")).toBe("image/tiff");
    expect(p.getAll("subset")).toEqual(["Long(20.9,21.1)", "Lat(35.1,35.3)"]);
    expect(p.has("subsettingCrs")).toBe(false);
  });

  it("coverageUrl adds the subsetting CRS and a quoted time slice when configured", () => {
    const url = new URL(
      coverageUrl(
        {
          wcsUrl: "https://wcs.example.invalid/wcs",
          coverageId: "emodnet__vesseldensity_allavg",
          subsettingCrs: "http://www.opengis.net/def/crs/EPSG/0/4326",
          time: "2024-01-01T00:00:00.000Z",
        },
        BOX,
      ),
    );
    expect(url.searchParams.get("subsettingCrs")).toBe("http://www.opengis.net/def/crs/EPSG/0/4326");
    expect(url.searchParams.getAll("subset")).toEqual([
      "Long(20.9,21.1)",
      "Lat(35.1,35.3)",
      'time("2024-01-01T00:00:00.000Z")',
    ]);
    // Literal quotes in the request target are rejected by the server (HTTP 400): they must be encoded.
    expect(url.href).not.toContain('"');
  });
});

describe("wfsPageUrl", () => {
  it("wfsPageUrl uses CRS84 and w,s,e,n order", () => {
    const url = new URL(
      wfsPageUrl({ url: "https://wfs.example.invalid/wfs", typeName: "emodnet:natura2000areas", bbox: BOX, startIndex: 1000, count: 1000 }),
    );
    const p = url.searchParams;
    expect(url.origin + url.pathname).toBe("https://wfs.example.invalid/wfs");
    expect(p.get("service")).toBe("WFS");
    expect(p.get("version")).toBe("2.0.0");
    expect(p.get("request")).toBe("GetFeature");
    expect(p.get("typeNames")).toBe("emodnet:natura2000areas");
    expect(p.get("outputFormat")).toBe("application/json");
    expect(p.get("srsName")).toBe("urn:ogc:def:crs:OGC:1.3:CRS84");
    expect(p.get("bbox")).toBe("20.9,35.1,21.1,35.3,urn:ogc:def:crs:OGC:1.3:CRS84");
    expect(p.get("count")).toBe("1000");
    expect(p.get("startIndex")).toBe("1000");
  });
});

describe("fetchWfsFeatures", () => {
  it("pages until a short page: 2 full + 1 partial → 3 calls, all features", async () => {
    const seen: HttpRequest[] = [];
    const pages = [featureCollection(2, 0), featureCollection(2, 2), featureCollection(1, 4)];
    const res = await fetchWfsFeatures(scriptedTransport(pages, seen), wfsInput(2), { db });
    expect(seen).toHaveLength(3);
    expect(seen.map((r) => new URL(r.url).searchParams.get("startIndex"))).toEqual(["0", "2", "4"]);
    expect(seen.every((r) => new URL(r.url).searchParams.get("count") === "2")).toBe(true);
    expect(seen.every((r) => r.timeoutMs === 180_000 && r.service === "emodnet-seabed")).toBe(true);
    expect(res.pages).toEqual(pages);
    expect(res.features.map((f) => f.id)).toEqual(["f.0", "f.1", "f.2", "f.3", "f.4"]);
  });

  it("an empty page after full pages ends the paging", async () => {
    const seen: HttpRequest[] = [];
    const res = await fetchWfsFeatures(scriptedTransport([featureCollection(2), featureCollection(0)], seen), wfsInput(2), {
      db,
    });
    expect(seen).toHaveLength(2);
    expect(res.features).toHaveLength(2);
  });

  it("invalid JSON from WFS is retryable", async () => {
    await expect(fetchWfsFeatures(scriptedTransport(["<html>busy</html>"]), wfsInput(2), { db })).rejects.toBeInstanceOf(
      RetryableHttpError,
    );
  });

  it("an OGC exception report from WFS is a non-retryable HttpError", async () => {
    const report = '<?xml version="1.0"?><ows:ExceptionReport><ows:Exception exceptionCode="InvalidParameterValue"/></ows:ExceptionReport>';
    const error = await fetchWfsFeatures(scriptedTransport([report]), wfsInput(2), { db }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as Error).message).toContain("InvalidParameterValue");
  });

  it("JSON without a features array is retryable", async () => {
    await expect(fetchWfsFeatures(scriptedTransport(['{"type":"x"}']), wfsInput(2), { db })).rejects.toBeInstanceOf(
      RetryableHttpError,
    );
  });

  it("more than 50 pages is an error", async () => {
    const seen: HttpRequest[] = [];
    await expect(fetchWfsFeatures(scriptedTransport([featureCollection(1)], seen), wfsInput(1), { db })).rejects.toThrow(
      /50 pages/,
    );
    expect(seen).toHaveLength(50);
  });
});

describe("fetchCoverage", () => {
  it("returns the TIFF bytes (little- and big-endian)", async () => {
    const little = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 1, 2, 3]);
    const big = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 4, 5]);
    expect(await fetchCoverage(scriptedTransport([little]), BOX, { db }, bathymetryCfg())).toEqual(little);
    expect(await fetchCoverage(scriptedTransport([big]), BOX, { db }, bathymetryCfg())).toEqual(big);
  });

  it("an OGC exception instead of a TIFF is a non-retryable HttpError", async () => {
    const report = `<?xml version="1.0"?><ows:ExceptionReport><ows:Exception exceptionCode="InvalidSubsetting">${"x".repeat(500)}</ows:Exception></ows:ExceptionReport>`;
    const error = await fetchCoverage(scriptedTransport([report]), BOX, { db }, bathymetryCfg()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).not.toBeInstanceOf(RetryableHttpError);
    expect((error as Error).message).toContain("InvalidSubsetting");
    expect((error as Error).message).toContain(report.slice(0, 200));
    expect((error as Error).message).not.toContain(report.slice(0, 201));
  });
});

describe("external_calls", () => {
  it("every call is recorded in external_calls with service emodnet-*", async () => {
    const runId = newId();
    const ctx = { db, runId, stage: "datasets.import" };
    await fetchCoverage(scriptedTransport([new Uint8Array([0x49, 0x49, 0x2a, 0x00])]), BOX, ctx, bathymetryCfg());
    await fetchWfsFeatures(scriptedTransport([featureCollection(2), featureCollection(1)]), wfsInput(2), ctx);
    const rows = await db.select().from(externalCalls).where(eq(externalCalls.runId, runId));
    expect(rows.map((r) => [r.service, r.operation, r.stage]).sort()).toEqual([
      ["emodnet-bathymetry", "GetCoverage", "datasets.import"],
      ["emodnet-seabed", "GetFeature", "datasets.import"],
      ["emodnet-seabed", "GetFeature", "datasets.import"],
    ]);
    expect(rows.every((r) => r.service.startsWith("emodnet-") && Number(r.costEur) === 0)).toBe(true);
  });
});
