import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "shapefile";
import { areaByKey, getConfig, type AreaConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import { areaBbox } from "../lib/domain/gazetteer/areas";
import { bufferBbox, importLandPolygons } from "../lib/domain/gazetteer/land";
import { areaTileIds } from "../lib/domain/gazetteer/tiles-ensure";
import { tileBbox, TILE_SIZE, type Bbox } from "../lib/domain/tiles";

const USAGE = "usage: import-land-polygons.ts --shp <path/land_polygons.shp> --area <key> [--version <YYYY-MM-DD>]";

export function parseArgs(argv: string[]): { shp: string; area: string; version: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--shp", "--area", "--version"].includes(flag) || value === undefined || value.startsWith("--")) {
      throw new Error(USAGE);
    }
    values.set(flag, value);
  }
  const shp = values.get("--shp");
  const area = values.get("--area");
  if (!shp || !area) throw new Error(USAGE);
  const version = values.get("--version") ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) throw new Error(`--version must be YYYY-MM-DD, got ${version}`);
  return { shp, area, version };
}

export async function* readShapefile(shp: string): AsyncGenerator<GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>> {
  const source = await open(shp);
  try {
    for (;;) {
      const { done, value } = await source.read();
      if (done) return;
      const g = value.geometry;
      if (g?.type === "Polygon" || g?.type === "MultiPolygon") {
        yield value as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
      }
    }
  } finally {
    await source.cancel();
  }
}

/**
 * The box land polygons are imported for: the area box plus `bufferKm`, snapped outward to the tile grid and
 * widened to every tile of `areaTileIds`, so `has_coast` of each area tile sees all land touching it.
 */
export function landImportBbox(area: AreaConfig, bufferKm: number): Bbox {
  const [w, s, e, n] = bufferBbox(areaBbox(area), bufferKm);
  let box: Bbox = [
    Math.floor(w / TILE_SIZE) * TILE_SIZE,
    Math.floor(s / TILE_SIZE) * TILE_SIZE,
    Math.ceil(e / TILE_SIZE) * TILE_SIZE,
    Math.ceil(n / TILE_SIZE) * TILE_SIZE,
  ];
  for (const id of areaTileIds(area)) {
    const [tw, ts, te, tn] = tileBbox(id);
    box = [Math.min(box[0], tw), Math.min(box[1], ts), Math.max(box[2], te), Math.max(box[3], tn)];
  }
  return box;
}

async function main(): Promise<void> {
  const { shp, area, version } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const bbox = landImportBbox(areaByKey(area), getConfig().gazetteer.landBufferKm);
  const { db, close } = createDb(url);
  try {
    const r = await importLandPolygons(db, readShapefile(shp), bbox, version);
    process.stdout.write(`inserted ${r.inserted}, replaced ${r.replaced} (version ${version})\n`);
  } finally {
    await close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
