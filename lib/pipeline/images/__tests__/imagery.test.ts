import { and, eq, isNull, sql } from "drizzle-orm";
import { writeArrayBuffer } from "geotiff";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { getConfig } from "@/lib/config";
import { externalCalls, imageryTiles } from "@/lib/db/schema";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { newId } from "@/lib/domain/ids";
import { currentAerialTiles, ensureImagery } from "@/lib/pipeline/images/imagery";

/** Just west of 23° E (outside the pilot box): the wide window crosses into the next DEM tile. */
const PLACE = { geoObjectId: newId(), lon: 22.995, lat: 37.49, country: "GR" };

const image = async (colour: { r: number; g: number; b: number }) =>
  new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: colour } }).jpeg().toBuffer());

const demTiff = () =>
  new Uint8Array(
    writeArrayBuffer(new Float32Array([0, 10, 20, 30]), { width: 2, height: 2, ModelPixelScale: [0.5, 0.5, 0], ModelTiepoint: [0, 0, 0, 22, 38, 0] }),
  );

/** Answers per service: cadastre (white or coloured), Sentinel-2 (coloured), DEM (a tiny GeoTIFF). */
async function syntheticTransport(opts: { blankCadastre: boolean }, seen: HttpRequest[] = []): Promise<Transport> {
  const cadastre = await image(opts.blankCadastre ? { r: 255, g: 255, b: 255 } : { r: 60, g: 120, b: 90 });
  const sentinel = await image({ r: 20, g: 90, b: 160 });
  const dem = demTiff();
  return async (req) => {
    seen.push(req);
    const body = req.service === "ktimatologio" ? cadastre : req.service === "sentinel2" ? sentinel : dem;
    return makeResponse(200, body);
  };
}

const refusing: Transport = async (req) => {
  throw new Error(`unexpected request ${req.service} ${req.url}`);
};

describe("ensureImagery", () => {
  it("ensureImagery fetches core, wide and DEM tiles and archives them", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const seen: HttpRequest[] = [];
      const set = await ensureImagery(tx, archive, await syntheticTransport({ blankCadastre: false }, seen), PLACE, { db: tx });
      expect(set.coreSource).toBe("ktimatologio");
      expect(set.core).toHaveLength(4);
      expect(set.wide).toHaveLength(1);
      expect(set.dem.map((d) => d.fileKey)).toEqual([
        "imagery/copernicus_dem/Copernicus_DSM_COG_10_N37_00_E022_00_DEM.tif",
        "imagery/copernicus_dem/Copernicus_DSM_COG_10_N37_00_E023_00_DEM.tif",
      ]);
      expect(set.core.every((t) => t.source === "ktimatologio" && !t.blank && t.resolutionM === 0.5)).toBe(true);
      expect(set.core[0]!.fileKey).toMatch(/^imagery\/ktimatologio\/.+\.jpg$/);
      expect(set.wide[0]!.acquiredAt).toBe(getConfig().images.sources.sentinel2.acquiredAt);
      expect(archive.keys()).toHaveLength(7);
      expect(archive.contentType(set.dem[0]!.fileKey)).toBe("image/tiff");
      expect(seen.map((r) => r.service).sort()).toEqual([
        "copernicus_dem",
        "copernicus_dem",
        "ktimatologio",
        "ktimatologio",
        "ktimatologio",
        "ktimatologio",
        "sentinel2",
      ]);

      // The core tiles together cover the core window around the place.
      const west = Math.min(...set.core.map((t) => t.bbox[0]));
      const east = Math.max(...set.core.map((t) => t.bbox[2]));
      expect(west).toBeLessThan(PLACE.lon);
      expect(east).toBeGreaterThan(PLACE.lon);

      const [row] = await tx.select().from(imageryTiles).where(eq(imageryTiles.id, set.core[0]!.id));
      expect(row).toMatchObject({ source: "ktimatologio", costEur: "0.000000", license: "CC-BY-3.0", watermarked: true, blank: false });
      expect(row!.bytes).toBeGreaterThan(0);
      const calls = await tx.select().from(externalCalls).where(eq(externalCalls.service, "ktimatologio"));
      expect(calls.length).toBeGreaterThanOrEqual(4);
    });
  });

  it("currentAerialTiles reads the stored core and wide refs without a request, null while one is missing", async () => {
    await withRollback(async (tx) => {
      expect(await currentAerialTiles(tx, PLACE)).toBeNull();
      const set = await ensureImagery(tx, memoryArchive(), await syntheticTransport({ blankCadastre: true }), PLACE, { db: tx });
      const current = await currentAerialTiles(tx, PLACE);
      expect(current!.core.map((t) => t.id)).toEqual(set.core.map((t) => t.id));
      expect(current!.wide.map((t) => t.id)).toEqual(set.wide.map((t) => t.id));
      expect(current!.core.every((t) => t.blank && t.resolutionM === 0.5)).toBe(true);
      expect(current!.wide[0]).toMatchObject({ source: "sentinel2", blank: false, resolutionM: 10 });
      // a tile ended (new imagery) makes the lookup null again
      await tx.execute(sql`update imagery_tiles set valid_to = now() where id = ${set.core[0]!.id}`);
      expect(await currentAerialTiles(tx, PLACE)).toBeNull();
    });
  });

  it("blank cadastre tile is stored with blank=true and coreSource is null", async () => {
    await withRollback(async (tx) => {
      const set = await ensureImagery(tx, memoryArchive(), await syntheticTransport({ blankCadastre: true }), PLACE, { db: tx });
      expect(set.coreSource).toBeNull();
      expect(set.core).toHaveLength(4);
      expect(set.core.every((t) => t.blank)).toBe(true);
      const rows = await tx
        .select()
        .from(imageryTiles)
        .where(and(eq(imageryTiles.source, "ktimatologio"), isNull(imageryTiles.validTo)));
      expect(rows.filter((r) => set.core.some((t) => t.id === r.id)).every((r) => r.blank)).toBe(true);
      expect(set.wide.every((t) => !t.blank)).toBe(true);
    });
  });

  it("ensureImagery reuses archived tiles without a request", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const first = await ensureImagery(tx, archive, await syntheticTransport({ blankCadastre: false }), PLACE, { db: tx });
      const second = await ensureImagery(tx, archive, refusing, PLACE, { db: tx });
      expect(second).toEqual(first);
    });
  });

  it("ensureImagery downloads a tile again when its archive object is gone", async () => {
    await withRollback(async (tx) => {
      const first = await ensureImagery(tx, memoryArchive(), await syntheticTransport({ blankCadastre: false }), PLACE, { db: tx });
      const seen: HttpRequest[] = [];
      const second = await ensureImagery(tx, memoryArchive(), await syntheticTransport({ blankCadastre: false }, seen), PLACE, { db: tx });
      expect(seen).toHaveLength(7);
      expect(second.core.map((t) => t.id)).toEqual(first.core.map((t) => t.id));
    });
  });

  it("country without source gets Sentinel-2 and DEM only", async () => {
    await withRollback(async (tx) => {
      const seen: HttpRequest[] = [];
      const set = await ensureImagery(tx, memoryArchive(), await syntheticTransport({ blankCadastre: false }, seen), { ...PLACE, country: "HR" }, { db: tx });
      expect(set.coreSource).toBeNull();
      expect(set.core).toEqual([]);
      expect(set.wide).toHaveLength(1);
      expect(set.dem).toHaveLength(2);
      expect(seen.some((r) => r.service === "ktimatologio")).toBe(false);
    });
  });
});
