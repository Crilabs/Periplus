import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "shapefile";
import { areaByKey, getConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import { areaBbox } from "../lib/domain/gazetteer/areas";
import { bufferBbox, importLandPolygons } from "../lib/domain/gazetteer/land";

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

async function* readShapefile(shp: string): AsyncGenerator<GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>> {
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

async function main(): Promise<void> {
  const { shp, area, version } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const bbox = bufferBbox(areaBbox(areaByKey(area)), getConfig().gazetteer.landBufferKm);
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
