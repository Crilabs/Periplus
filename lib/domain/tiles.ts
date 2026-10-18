/** Fixed 0.25 degree tile grid. Must stay in sync with the SQL function tile_id_for(). */
export type Bbox = [west: number, south: number, east: number, north: number];

export const TILE_SIZE = 0.25;
export const TILE_PREFIX = "q025";

const COLS = 360 / TILE_SIZE;
const ROWS = 180 / TILE_SIZE;

function formatTileId(col: number, row: number): string {
  return `${TILE_PREFIX}:${col}:${row}`;
}

/** A coordinate exactly on a tile edge belongs to the tile east / north of it. */
export function tileIdFor(lon: number, lat: number): string {
  if (!(lon >= -180 && lon < 180)) throw new RangeError(`lon out of range [-180, 180): ${lon}`);
  if (!(lat >= -90 && lat < 90)) throw new RangeError(`lat out of range [-90, 90): ${lat}`);
  return formatTileId(Math.floor((lon + 180) / TILE_SIZE), Math.floor((lat + 90) / TILE_SIZE));
}

export function parseTileId(id: string): { col: number; row: number } {
  const m = /^q025:(\d+):(\d+)$/.exec(id);
  if (!m) throw new Error(`invalid tile id: ${id}`);
  const col = Number(m[1]);
  const row = Number(m[2]);
  if (col >= COLS || row >= ROWS) throw new Error(`tile id outside grid: ${id}`);
  return { col, row };
}

export function tileBbox(id: string): Bbox {
  const { col, row } = parseTileId(id);
  return [
    col * TILE_SIZE - 180,
    row * TILE_SIZE - 90,
    (col + 1) * TILE_SIZE - 180,
    (row + 1) * TILE_SIZE - 90,
  ];
}

/** Order: N, NE, E, SE, S, SW, W, NW. Columns wrap at the antimeridian; rows beyond a pole are omitted. */
export function tileNeighbours(id: string): string[] {
  const { col, row } = parseTileId(id);
  const steps: Array<[number, number]> = [
    [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1],
  ];
  const out: string[] = [];
  for (const [dc, dr] of steps) {
    const r = row + dr;
    if (r < 0 || r >= ROWS) continue;
    out.push(formatTileId((col + dc + COLS) % COLS, r));
  }
  return out;
}

/** All tiles intersecting the box; an east/north edge exactly on a tile boundary excludes the next tile. */
export function tilesInBbox([west, south, east, north]: Bbox): string[] {
  const colMin = Math.max(0, Math.floor((west + 180) / TILE_SIZE));
  const rowMin = Math.max(0, Math.floor((south + 90) / TILE_SIZE));
  const colMax = Math.min(COLS - 1, Math.max(colMin, Math.ceil((east + 180) / TILE_SIZE) - 1));
  const rowMax = Math.min(ROWS - 1, Math.max(rowMin, Math.ceil((north + 90) / TILE_SIZE) - 1));
  const out: string[] = [];
  for (let col = colMin; col <= colMax; col++) {
    for (let row = rowMin; row <= rowMax; row++) out.push(formatTileId(col, row));
  }
  return out;
}
