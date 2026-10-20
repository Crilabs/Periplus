import { writeArrayBuffer } from "geotiff";
import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { getConfig } from "@/lib/config";
import { HttpError, capBody, makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { demTileNames, fetchDemTile } from "@/lib/adapters/copernicus-dem";

const db = testDb();

/** Unique template per test keeps the shared rate bucket apart; the huge rate never blocks. */
const demCfg = () => ({
  ...getConfig().images.sources.copernicus_dem,
  urlTemplate: `https://dem.example.invalid/${crypto.randomUUID()}/{name}/{name}.tif`,
  ratePerMinute: 1_000_000,
});

const tiff = () =>
  new Uint8Array(
    writeArrayBuffer(new Float32Array([1, 2, 3, 4]), { width: 2, height: 2, ModelPixelScale: [0.5, 0.5, 0], ModelTiepoint: [0, 0, 0, 23, 38, 0] }),
  );

function answering(status: number, body: Uint8Array, seen: HttpRequest[] = []): Transport {
  return async (req) => {
    seen.push(req);
    const capped = capBody(body, req.maxBodyBytes);
    return makeResponse(status, capped.body, { truncated: capped.truncated });
  };
}

describe("demTileNames", () => {
  it("demTileNames covers both tiles for a window across 23° E", () => {
    expect(demTileNames([22.94, 37.45, 23.06, 37.54])).toEqual([
      "Copernicus_DSM_COG_10_N37_00_E022_00_DEM",
      "Copernicus_DSM_COG_10_N37_00_E023_00_DEM",
    ]);
  });

  it("demTileNames handles south and west", () => {
    expect(demTileNames([-0.05, -1.02, 0.05, -0.98])).toEqual([
      "Copernicus_DSM_COG_10_S02_00_W001_00_DEM",
      "Copernicus_DSM_COG_10_S02_00_E000_00_DEM",
      "Copernicus_DSM_COG_10_S01_00_W001_00_DEM",
      "Copernicus_DSM_COG_10_S01_00_E000_00_DEM",
    ]);
  });

  it("demTileNames leaves out a tile the box only touches on its east or north edge", () => {
    expect(demTileNames([22.5, 37.5, 23, 38])).toEqual(["Copernicus_DSM_COG_10_N37_00_E022_00_DEM"]);
  });
});

describe("fetchDemTile", () => {
  it("fetchDemTile downloads the COG of the tile with the byte cap", async () => {
    const cfg = demCfg();
    const seen: HttpRequest[] = [];
    const body = tiff();
    const bytes = await fetchDemTile(answering(200, body, seen), "Copernicus_DSM_COG_10_N37_00_E023_00_DEM", { db }, cfg);
    expect(bytes).toEqual(body);
    expect(seen[0]!.url).toBe(cfg.urlTemplate.replaceAll("{name}", "Copernicus_DSM_COG_10_N37_00_E023_00_DEM"));
    expect(seen[0]!.maxBodyBytes).toBe(cfg.maxBytes);
    expect(seen[0]!.service).toBe("copernicus_dem");
  });

  it("fetchDemTile refuses a body that is no TIFF", async () => {
    const call = fetchDemTile(answering(200, new TextEncoder().encode("<Error>nope</Error>")), "X", { db }, demCfg());
    await expect(call).rejects.toThrow(HttpError);
  });

  it("fetchDemTile refuses a body cut at maxBytes", async () => {
    const body = tiff();
    const call = fetchDemTile(answering(200, body), "X", { db }, { ...demCfg(), maxBytes: 8 });
    await expect(call).rejects.toThrow(/maxBytes|larger/);
  });

  it("fetchDemTile returns null for a tile that does not exist (open sea)", async () => {
    const body = new TextEncoder().encode("<Error><Code>NoSuchKey</Code></Error>");
    await expect(fetchDemTile(answering(404, body), "X", { db }, demCfg())).resolves.toBeNull();
  });
});
