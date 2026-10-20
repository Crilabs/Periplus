import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { newId } from "@/lib/domain/ids";
import type { Bbox } from "@/lib/domain/tiles";
import { HttpError, makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { fetchWmsImage, isBlankImage, wmsGrid } from "@/lib/adapters/wms";

const db = testDb();

/** Synthetic box around 21.0 E / 35.2 N (outside the pilot box). */
const BOX: Bbox = [20.99, 35.19, 21.01, 35.21];

const rgbImage = (format: "jpeg" | "png", colour: { r: number; g: number; b: number }) =>
  sharp({ create: { width: 16, height: 16, channels: 3, background: colour } })[format]().toBuffer();

function answering(body: Uint8Array, seen: HttpRequest[] = []): Transport {
  return async (req) => {
    seen.push(req);
    return makeResponse(200, body);
  };
}

describe("wmsGrid", () => {
  it("wmsGrid splits 1500 m at 0.5 m into 2×2 requests of 1500 px", () => {
    const lat = 35.2;
    const dLat = 750 / 111_320;
    const dLon = 750 / (111_320 * Math.cos((lat * Math.PI) / 180));
    const grid = wmsGrid([21 - dLon, lat - dLat, 21 + dLon, lat + dLat], 0.5, 2048);
    expect(grid).toHaveLength(4);
    for (const cell of grid) {
      expect(cell.width).toBe(1500);
      expect(cell.height).toBe(1500);
    }
    // The cells tile the box without gaps.
    const wests = [...new Set(grid.map((c) => c.bbox[0]))].sort();
    expect(wests).toHaveLength(2);
    expect(grid.map((c) => c.tileKey)).toEqual([...new Set(grid.map((c) => c.tileKey))]);
  });

  it("wmsGrid keeps a box within maxRequestPx in one request with a stable key", () => {
    const grid = wmsGrid(BOX, 10, 2048);
    expect(grid).toHaveLength(1);
    expect(grid[0]!.bbox).toEqual(BOX);
    expect(grid[0]!.tileKey).toBe("10/20.99000_35.19000");
    expect(wmsGrid([20.990001, 35.190001, 21.01, 35.21], 10, 2048)[0]!.tileKey).toBe(grid[0]!.tileKey);
  });
});

describe("fetchWmsImage", () => {
  const req = () => ({ url: `https://wms.example.invalid/${newId()}/wms`, layer: "BASEMAP", format: "image/jpeg", bbox: BOX, width: 400, height: 300 });

  it("fetchWmsImage sends a WMS 1.1.1 GetMap in EPSG:4326 and returns the image", async () => {
    const jpeg = new Uint8Array(await rgbImage("jpeg", { r: 20, g: 90, b: 160 }));
    const seen: HttpRequest[] = [];
    const r = req();
    const bytes = await fetchWmsImage(answering(jpeg, seen), r, { db }, "ktimatologio");
    expect(bytes).toEqual(jpeg);
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe(r.url);
    const p = url.searchParams;
    expect(p.get("SERVICE")).toBe("WMS");
    expect(p.get("VERSION")).toBe("1.1.1");
    expect(p.get("REQUEST")).toBe("GetMap");
    expect(p.get("LAYERS")).toBe("BASEMAP");
    expect(p.get("STYLES")).toBe("");
    expect(p.get("SRS")).toBe("EPSG:4326");
    expect(p.get("BBOX")).toBe("20.99,35.19,21.01,35.21");
    expect(p.get("WIDTH")).toBe("400");
    expect(p.get("HEIGHT")).toBe("300");
    expect(p.get("FORMAT")).toBe("image/jpeg");
    expect(seen[0]!.service).toBe("ktimatologio");
  });

  it("fetchWmsImage accepts PNG", async () => {
    const png = new Uint8Array(await rgbImage("png", { r: 20, g: 90, b: 160 }));
    await expect(fetchWmsImage(answering(png), { ...req(), format: "image/png" }, { db }, "sentinel2")).resolves.toEqual(png);
  });

  it("fetchWmsImage turns ServiceException XML into HttpError", async () => {
    const xml =
      '<?xml version="1.0"?><ServiceExceptionReport version="1.1.1"><ServiceException code="InvalidSRS">SRS not supported</ServiceException></ServiceExceptionReport>';
    const call = fetchWmsImage(answering(new TextEncoder().encode(xml)), req(), { db }, "ktimatologio");
    await expect(call).rejects.toThrow(HttpError);
    await expect(fetchWmsImage(answering(new TextEncoder().encode(xml)), req(), { db }, "ktimatologio")).rejects.toThrow(
      /SRS not supported/,
    );
  });
});

describe("isBlankImage", () => {
  it("isBlankImage is true for an all-white tile and false for a coloured one", async () => {
    const white = new Uint8Array(await rgbImage("jpeg", { r: 255, g: 255, b: 255 }));
    const sea = new Uint8Array(await rgbImage("jpeg", { r: 20, g: 90, b: 160 }));
    expect(await isBlankImage(white, 245)).toBe(true);
    expect(await isBlankImage(sea, 245)).toBe(false);
  });

  it("isBlankImage is false when a single pixel is dark", async () => {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: { create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }, left: 3, top: 3 }])
      .png()
      .toBuffer();
    expect(await isBlankImage(new Uint8Array(png), 245)).toBe(false);
  });
});
