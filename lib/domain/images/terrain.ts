import { fromArrayBuffer } from "geotiff";
import { metresPerDegreeLon, METRES_PER_DEGREE, type Bbox } from "./window";

/**
 * Heights over `bbox` on a regular grid of `cols` × `rows` nodes that include the box's edges (node `(j, i)` at
 * `west + j·Δlon`, `south + i·Δlat`); row 0 is the south edge, `heights[i · cols + j]`.
 */
export type HeightGrid = { bbox: Bbox; cols: number; rows: number; heights: Float32Array };

/** Heights below this are sea (DEM noise along the coast). */
const SEA_LEVEL_NOISE_M = 0.5;
/** Pixels read beyond the box on every side, so bilinear neighbours at its edges are there. */
const READ_MARGIN_PX = 2;

/** One DEM tile's pixels around the box: pixel `(col, row)` of the tile, centre at `x0 + col·dx`, `y0 − row·dy`. */
type TileWindow = {
  /** Centre of the tile's pixel (0, 0). */
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  width: number;
  height: number;
  /** The read window in tile pixels and its values (row-major). */
  left: number;
  top: number;
  cols: number;
  rows: number;
  values: ArrayLike<number>;
  noData: number | null;
};

async function readWindow(bytes: Uint8Array, bbox: Bbox): Promise<TileWindow | null> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const image = await (await fromArrayBuffer(buffer)).getImage();
  const [originX, originY] = image.getOrigin();
  const [dx, negDy] = image.getResolution();
  const dy = Math.abs(negDy!);
  // PixelIsPoint (GTRasterTypeGeoKey 2): the tie point is the centre of pixel (0, 0); otherwise its top-left corner.
  const isPoint = image.getGeoKeys()?.GTRasterTypeGeoKey === 2;
  const x0 = originX! + (isPoint ? 0 : dx! / 2);
  const y0 = originY! - (isPoint ? 0 : dy / 2);
  const width = image.getWidth();
  const height = image.getHeight();

  const left = Math.max(0, Math.floor((bbox[0] - x0) / dx!) - READ_MARGIN_PX);
  const right = Math.min(width, Math.ceil((bbox[2] - x0) / dx!) + 1 + READ_MARGIN_PX);
  const top = Math.max(0, Math.floor((y0 - bbox[3]) / dy) - READ_MARGIN_PX);
  const bottom = Math.min(height, Math.ceil((y0 - bbox[1]) / dy) + 1 + READ_MARGIN_PX);
  if (left >= right || top >= bottom) return null;

  const [values] = await image.readRasters({ window: [left, top, right, bottom], samples: [0] });
  return {
    x0,
    y0,
    dx: dx!,
    dy,
    width,
    height,
    left,
    top,
    cols: right - left,
    rows: bottom - top,
    values: values as ArrayLike<number>,
    noData: image.getGDALNoData(),
  };
}

/** The value of the DEM pixel whose centre is (`lon`, `lat`), from whichever tile has it; `null` if none does. */
function pixelAt(tiles: TileWindow[], lon: number, lat: number): number | null {
  for (const t of tiles) {
    const col = Math.round((lon - t.x0) / t.dx);
    const row = Math.round((t.y0 - lat) / t.dy);
    if (col < 0 || row < 0 || col >= t.width || row >= t.height) continue;
    const c = col - t.left;
    const r = row - t.top;
    if (c < 0 || r < 0 || c >= t.cols || r >= t.rows) continue;
    const v = t.values[r * t.cols + c]!;
    return Number.isFinite(v) && v !== t.noData ? v : null;
  }
  return null;
}

/**
 * Bilinear height at (`lon`, `lat`) on the pixel-centre lattice of the first tile, its four neighbours taken from
 * whichever tile holds them: across a tile edge the next tile supplies them, so two tiles merge without a seam. A
 * neighbour no tile has (open sea without a DEM tile, nodata) drops out and the others are reweighted; none → 0.
 */
function bilinear(tiles: TileWindow[], lon: number, lat: number): number {
  const ref = tiles[0]!;
  const u = (lon - ref.x0) / ref.dx;
  const v = (ref.y0 - lat) / ref.dy;
  const c0 = Math.floor(u);
  const r0 = Math.floor(v);
  const fu = u - c0;
  const fv = v - r0;
  let sum = 0;
  let weight = 0;
  for (const [dc, dr, w] of [
    [0, 0, (1 - fu) * (1 - fv)],
    [1, 0, fu * (1 - fv)],
    [0, 1, (1 - fu) * fv],
    [1, 1, fu * fv],
  ] as const) {
    if (w === 0) continue;
    const value = pixelAt(tiles, ref.x0 + (c0 + dc) * ref.dx, ref.y0 - (r0 + dr) * ref.dy);
    if (value === null) continue;
    sum += value * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : 0;
}

/**
 * Heights over `bbox` every `stepM` metres (at most; the grid includes both edges) from the DEM GeoTIFFs `tiffs`:
 * every tile overlapping the box is read (only the window around the box) and sampled bilinearly. Heights below 0
 * become 0 and those below 0.5 m too (sea). Without any tile under the box every height is 0 (open sea).
 */
export async function sampleDem(tiffs: Uint8Array[], bbox: Bbox, stepM: number): Promise<HeightGrid> {
  const [west, south, east, north] = bbox;
  const cols = Math.max(2, Math.ceil(((east - west) * metresPerDegreeLon((south + north) / 2)) / stepM) + 1);
  const rows = Math.max(2, Math.ceil(((north - south) * METRES_PER_DEGREE) / stepM) + 1);
  const heights = new Float32Array(cols * rows);

  const tiles = (await Promise.all(tiffs.map((t) => readWindow(t, bbox)))).filter((t): t is TileWindow => t !== null);
  if (tiles.length === 0) return { bbox, cols, rows, heights };

  for (let i = 0; i < rows; i++) {
    const lat = south + ((north - south) * i) / (rows - 1);
    for (let j = 0; j < cols; j++) {
      const lon = west + ((east - west) * j) / (cols - 1);
      const h = bilinear(tiles, lon, lat);
      heights[i * cols + j] = h < SEA_LEVEL_NOISE_M ? 0 : h;
    }
  }
  return { bbox, cols, rows, heights };
}
