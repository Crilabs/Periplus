import sharp from "sharp";
import { METRES_PER_DEGREE, metresPerDegreeLon } from "@/lib/domain/images/window";
import type { Bbox } from "@/lib/domain/tiles";
import { HttpError, httpCall, type CallContext, type Transport } from "./http";

/** One GetMap request of a WMS grid; `tileKey` identifies it per source (`<resolutionM>/<west>_<south>`). */
export type WmsGridCell = { bbox: Bbox; width: number; height: number; tileKey: string };

export type WmsImageRequest = {
  url: string;
  layer: string;
  format: string;
  bbox: Bbox;
  width: number;
  height: number;
  /** Default 60 s. */
  timeoutSeconds?: number;
  /** Requests per minute of the bucket `http:<service>`; omitted = unlimited. */
  ratePerMinute?: number;
};

const DEFAULT_TIMEOUT_SECONDS = 60;

/** Start of a response for error messages: enough to show a WMS ServiceException. */
const snippet = (text: string) => text.slice(0, 300);

/** Rounded to 1e-5 degrees (about 1 m) and without a negative zero, so the same place gives the same key. */
const keyCoord = (value: number) => (Math.round(value * 1e5) / 1e5 + 0).toFixed(5);

/**
 * Splits `bbox` into n × n GetMap requests so that none exceeds `maxRequestPx` per side at `resolutionM` metres per
 * pixel (pixel counts from the box's extent in metres at its middle latitude). Cells run west to east, then south to
 * north.
 */
export function wmsGrid(bbox: Bbox, resolutionM: number, maxRequestPx: number): WmsGridCell[] {
  const [west, south, east, north] = bbox;
  const midLat = (south + north) / 2;
  const pxX = Math.max(1, Math.round(((east - west) * metresPerDegreeLon(midLat)) / resolutionM));
  const pxY = Math.max(1, Math.round(((north - south) * METRES_PER_DEGREE) / resolutionM));
  const n = Math.max(Math.ceil(pxX / maxRequestPx), Math.ceil(pxY / maxRequestPx));
  const stepLon = (east - west) / n;
  const stepLat = (north - south) / n;
  const cells: WmsGridCell[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const cell: Bbox = [
        west + col * stepLon,
        south + row * stepLat,
        col === n - 1 ? east : west + (col + 1) * stepLon,
        row === n - 1 ? north : south + (row + 1) * stepLat,
      ];
      cells.push({
        bbox: cell,
        width: Math.round(pxX / n),
        height: Math.round(pxY / n),
        tileKey: `${resolutionM}/${keyCoord(cell[0])}_${keyCoord(cell[1])}`,
      });
    }
  }
  return cells;
}

/** WMS 1.1.1 GetMap URL; EPSG:4326 in 1.1.1 takes the box in lon/lat order. */
export function getMapUrl(req: Pick<WmsImageRequest, "url" | "layer" | "format" | "bbox" | "width" | "height">): string {
  const params = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.1.1",
    REQUEST: "GetMap",
    LAYERS: req.layer,
    STYLES: "",
    SRS: "EPSG:4326",
    BBOX: req.bbox.join(","),
    WIDTH: String(req.width),
    HEIGHT: String(req.height),
    FORMAT: req.format,
  });
  return `${req.url}${req.url.includes("?") ? "&" : "?"}${params}`;
}

function isJpeg(body: Uint8Array): boolean {
  return body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
}

function isPng(body: Uint8Array): boolean {
  return body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47;
}

/**
 * One GetMap image. WMS servers answer a bad request with a ServiceException XML and status 200; a body that is
 * neither JPEG nor PNG becomes a non-retryable `HttpError` carrying the start of the answer.
 */
export async function fetchWmsImage(
  transport: Transport,
  req: WmsImageRequest,
  ctx: CallContext,
  service: string,
): Promise<Uint8Array> {
  const res = await httpCall(
    transport,
    {
      service,
      operation: "GetMap",
      url: getMapUrl(req),
      timeoutMs: (req.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
      ratePerMinute: req.ratePerMinute,
    },
    ctx,
  );
  if (!isJpeg(res.body) && !isPng(res.body)) {
    throw new HttpError(`${service} GetMap ${req.layer} returned no image: ${snippet(res.text())}`, res.status);
  }
  return res.body;
}

/** True when every pixel is white: the smallest value of each colour channel is at least `whiteThreshold`. */
export async function isBlankImage(bytes: Uint8Array, whiteThreshold: number): Promise<boolean> {
  const image = sharp(bytes);
  const [{ channels }, { hasAlpha }] = await Promise.all([image.stats(), image.metadata()]);
  const colour = hasAlpha ? channels.slice(0, -1) : channels;
  return colour.every((c) => c.min >= whiteThreshold);
}
