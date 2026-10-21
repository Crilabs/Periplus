import type { ImagesConfig } from "@/lib/config";
import type { Bbox } from "@/lib/domain/tiles";
import { HttpError, httpCall, type CallContext, type Transport } from "./http";

type DemConfig = Pick<ImagesConfig["sources"]["copernicus_dem"], "urlTemplate" | "timeoutSeconds" | "ratePerMinute" | "maxBytes">;

export const DEM_SERVICE = "copernicus_dem";

const pad = (value: number, width: number) => String(Math.abs(value)).padStart(width, "0");

/** Copernicus DEM GLO-30 name of the 1° tile whose south-west corner is (`lon`, `lat`). */
export function demTileName(lon: number, lat: number): string {
  return `Copernicus_DSM_COG_10_${lat < 0 ? "S" : "N"}${pad(lat, 2)}_00_${lon < 0 ? "W" : "E"}${pad(lon, 3)}_00_DEM`;
}

/** South-west corner of a tile name of `demTileName`. */
export function demTileCorner(name: string): { lon: number; lat: number } {
  const m = /^Copernicus_DSM_COG_10_([NS])(\d{2})_00_([EW])(\d{3})_00_DEM$/.exec(name);
  if (!m) throw new Error(`invalid Copernicus DEM tile name: ${name}`);
  return { lat: (m[1] === "S" ? -1 : 1) * Number(m[2]), lon: (m[3] === "W" ? -1 : 1) * Number(m[4]) };
}

/**
 * The 1° tiles covering `bbox`, south to north, then west to east. Corners floor (S01 covers -1..0); a tile the box
 * only touches on its east or north edge is left out.
 */
export function demTileNames(bbox: Bbox): string[] {
  const [west, south, east, north] = bbox;
  const lastLon = Math.max(Math.floor(west), Math.ceil(east) - 1);
  const lastLat = Math.max(Math.floor(south), Math.ceil(north) - 1);
  const names: string[] = [];
  for (let lat = Math.floor(south); lat <= lastLat; lat++) {
    for (let lon = Math.floor(west); lon <= lastLon; lon++) names.push(demTileName(lon, lat));
  }
  return names;
}

function isTiff(body: Uint8Array): boolean {
  const [a, b, c, d] = body;
  return (a === 0x49 && b === 0x49 && c === 0x2a && d === 0x00) || (a === 0x4d && b === 0x4d && c === 0x00 && d === 0x2a);
}

/**
 * The whole COG of one DEM tile, at most `maxBytes`. Returns null when the tile does not exist (404, or 403 from an S3
 * bucket that hides missing keys): GLO-30 has no tiles over open sea. A body cut at `maxBytes` or one that is no TIFF
 * is a non-retryable `HttpError`.
 */
export async function fetchDemTile(transport: Transport, name: string, ctx: CallContext, cfg: DemConfig): Promise<Uint8Array | null> {
  const res = await httpCall(
    transport,
    {
      service: DEM_SERVICE,
      operation: "GetTile",
      url: cfg.urlTemplate.replaceAll("{name}", name),
      timeoutMs: cfg.timeoutSeconds * 1000,
      ratePerMinute: cfg.ratePerMinute,
      maxBodyBytes: cfg.maxBytes,
      okStatuses: [403, 404],
      meta: { tile: name },
    },
    ctx,
  );
  if (res.status === 403 || res.status === 404) return null;
  if (res.truncated) throw new HttpError(`${DEM_SERVICE} ${name} is larger than maxBytes ${cfg.maxBytes}`, res.status);
  if (!isTiff(res.body)) {
    throw new HttpError(`${DEM_SERVICE} ${name} returned no TIFF: ${res.text().slice(0, 200)}`, res.status);
  }
  return res.body;
}
