import { and, eq, isNull, sql } from "drizzle-orm";
import { demTileCorner, demTileNames, fetchDemTile } from "@/lib/adapters/copernicus-dem";
import type { CallContext, Transport } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import { fetchWmsImage, isBlankImage, wmsGrid, type WmsGridCell } from "@/lib/adapters/wms";
import { getConfig, type ImagesConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { imageryTiles, type ImagerySource } from "@/lib/db/schema";
import { coreWindow, wideWindow, type Bbox } from "@/lib/domain/images/window";

export type ImageryTileRef = {
  id: string;
  source: ImagerySource;
  bbox: Bbox;
  fileKey: string;
  resolutionM: number;
  acquiredAt: string | null;
  blank: boolean;
};

/**
 * The imagery a render of a place builds on: detailed aerial tiles of the core window (cadastre), satellite tiles of
 * the wide window and the DEM tiles under the wide window. `coreSource` is null when the country has no detailed
 * source or every core tile came back blank.
 */
export type ImagerySet = {
  core: ImageryTileRef[];
  wide: ImageryTileRef[];
  dem: ImageryTileRef[];
  coreSource: "ktimatologio" | null;
};

/** Where imagery is fetched: around `lon`, `lat`; `coreSizeM` the side of the core window (default `window.coreSizeM`, spec 19 `coreSizeFor`). */
export type ImageryPlace = { geoObjectId: string; lon: number; lat: number; country: string; coreSizeM?: number };

type WmsSourceName = "ktimatologio" | "sentinel2";
type SourceMeta = { license: string; attribution: string; acquiredAt: string | null; watermarked: boolean };

const covers = (countries: string[] | "*", country: string) => countries === "*" || countries.includes(country);

const polygonOf = ([west, south, east, north]: Bbox) => ({
  type: "Polygon" as const,
  coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
});

const extensionOf = (format: string) => (format === "image/png" ? "png" : "jpg");

/** Selected columns of a current `imagery_tiles` row, with the bbox as numbers. */
const refColumns = {
  id: imageryTiles.id,
  source: imageryTiles.source,
  fileKey: imageryTiles.fileKey,
  resolutionM: imageryTiles.resolutionM,
  acquiredAt: imageryTiles.acquiredAt,
  blank: imageryTiles.blank,
  west: sql<number>`ST_XMin(${imageryTiles.bbox})`.mapWith(Number),
  south: sql<number>`ST_YMin(${imageryTiles.bbox})`.mapWith(Number),
  east: sql<number>`ST_XMax(${imageryTiles.bbox})`.mapWith(Number),
  north: sql<number>`ST_YMax(${imageryTiles.bbox})`.mapWith(Number),
};

type RefRow = { id: string; source: ImagerySource; fileKey: string; resolutionM: number; acquiredAt: string | null; blank: boolean; west: number; south: number; east: number; north: number };

const toRef = (row: RefRow): ImageryTileRef => ({
  id: row.id,
  source: row.source,
  bbox: [row.west, row.south, row.east, row.north],
  fileKey: row.fileKey,
  resolutionM: row.resolutionM,
  acquiredAt: row.acquiredAt,
  blank: row.blank,
});

/**
 * One tile, archive first: a current row of `(source, tileKey)` whose archive object exists is reused without a
 * request. Otherwise the tile is downloaded, archived under `imagery/<source>/<tileKey>.<ext>` and its row written
 * (inserted, or updated when the row exists but its object is gone). `download` returning null (a DEM tile over open
 * sea) leaves no row and yields null.
 */
async function ensureTile(
  db: Db,
  archive: Archive,
  tile: {
    source: ImagerySource;
    tileKey: string;
    bbox: Bbox;
    resolutionM: number;
    ext: string;
    contentType: string;
    meta: SourceMeta;
    download: () => Promise<Uint8Array | null>;
    isBlank: (bytes: Uint8Array) => Promise<boolean>;
  },
): Promise<ImageryTileRef | null> {
  const current = and(eq(imageryTiles.source, tile.source), eq(imageryTiles.tileKey, tile.tileKey), isNull(imageryTiles.validTo));
  const [existing] = await db.select(refColumns).from(imageryTiles).where(current);
  if (existing && (await archive.exists(existing.fileKey))) return toRef(existing);

  const bytes = await tile.download();
  if (!bytes) return null;
  const fileKey = `imagery/${tile.source}/${tile.tileKey}.${tile.ext}`;
  await archive.put(fileKey, bytes, tile.contentType);
  const blank = await tile.isBlank(bytes);
  const values = {
    bbox: sql`${geomFromGeoJson(polygonOf(tile.bbox))}`,
    resolutionM: tile.resolutionM,
    acquiredAt: tile.meta.acquiredAt,
    license: tile.meta.license,
    attribution: tile.meta.attribution,
    fileKey,
    bytes: bytes.byteLength,
    watermarked: tile.meta.watermarked,
    blank,
    costEur: "0",
  };
  const [row] = existing
    ? await db.update(imageryTiles).set(values).where(eq(imageryTiles.id, existing.id)).returning(refColumns)
    : await db.insert(imageryTiles).values({ source: tile.source, tileKey: tile.tileKey, ...values }).returning(refColumns);
  return toRef(row!);
}

/** The aerial tiles of a render as the generation key and the zoom choice read them: core (cadastre) and wide (Sentinel-2). */
export type AerialTiles = Pick<ImagerySet, "core" | "wide">;

/**
 * The WMS cells of the aerial imagery of `place`: the cadastre grid of the core window when the place's country has
 * the cadastre, then the Sentinel-2 grid of the wide window when it has Sentinel-2. `ensureImagery` fetches exactly
 * these, `currentAerialTiles` looks them up.
 */
function aerialGrids(place: Omit<ImageryPlace, "geoObjectId">, cfg: ImagesConfig): Array<{ source: WmsSourceName; cells: WmsGridCell[] }> {
  const grids: Array<{ source: WmsSourceName; cells: WmsGridCell[] }> = [];
  const grid = (source: WmsSourceName, bbox: Bbox) => {
    const src = cfg.sources[source];
    if (covers(src.countries, place.country)) grids.push({ source, cells: wmsGrid(bbox, src.resolutionM, src.maxRequestPx) });
  };
  grid("ktimatologio", coreWindow(place.lon, place.lat, cfg.window, place.coreSizeM));
  grid("sentinel2", wideWindow(place.lon, place.lat, cfg.window));
  return grids;
}

/**
 * The current aerial tiles (core and wide, in the order `ensureImagery` returns them) `ensureImagery` would use for
 * `place`, read without any request; `null` when one of them has no current row yet (`ensureImagery` would download
 * it: the imagery is new). A row whose archive object is gone keeps its id when downloaded again, so it counts as
 * present.
 */
export async function currentAerialTiles(
  db: Db,
  place: Omit<ImageryPlace, "geoObjectId">,
  cfg: ImagesConfig = getConfig().images,
): Promise<AerialTiles | null> {
  const grids = aerialGrids(place, cfg);
  const wanted = grids.flatMap((g) => g.cells.map((c) => ({ source: g.source, tileKey: c.tileKey })));
  const found = new Map<string, ImageryTileRef>();
  if (wanted.length > 0) {
    const rows = await db
      .select({ ...refColumns, tileKey: imageryTiles.tileKey })
      .from(imageryTiles)
      .where(
        and(
          isNull(imageryTiles.validTo),
          sql`(${imageryTiles.source}::text, ${imageryTiles.tileKey}) in (select source, "tileKey" from jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) as w(source text, "tileKey" text))`,
        ),
      );
    for (const row of rows) found.set(`${row.source}\0${row.tileKey}`, toRef(row));
  }
  const tiles: AerialTiles = { core: [], wide: [] };
  for (const grid of grids) {
    for (const cell of grid.cells) {
      const ref = found.get(`${grid.source}\0${cell.tileKey}`);
      if (!ref) return null;
      (grid.source === "ktimatologio" ? tiles.core : tiles.wide).push(ref);
    }
  }
  return tiles;
}

async function ensureWmsTiles(
  db: Db,
  archive: Archive,
  transport: Transport,
  source: WmsSourceName,
  cells: WmsGridCell[],
  ctx: CallContext,
  cfg: ImagesConfig,
): Promise<ImageryTileRef[]> {
  const src = cfg.sources[source];
  const refs: ImageryTileRef[] = [];
  for (const cell of cells) {
    const ref = await ensureTile(db, archive, {
      source,
      tileKey: cell.tileKey,
      bbox: cell.bbox,
      resolutionM: src.resolutionM,
      ext: extensionOf(src.format),
      contentType: src.format,
      meta: src,
      download: () =>
        fetchWmsImage(
          transport,
          { url: src.url, layer: src.layer, format: src.format, bbox: cell.bbox, width: cell.width, height: cell.height, timeoutSeconds: src.timeoutSeconds, ratePerMinute: src.ratePerMinute },
          ctx,
          source,
        ),
      isBlank: (bytes) => isBlankImage(bytes, cfg.window.whiteThreshold),
    });
    refs.push(ref!);
  }
  return refs;
}

/**
 * The imagery of a place, fetched only where not archived yet: the cadastre grid of the core window when the place's
 * country has it, the Sentinel-2 grid of the wide window, and the DEM tiles under the wide window (the renderer needs
 * heights for the whole wide mesh). Free sources only, so no budget; `httpCall` records each request in
 * `external_calls`. Pass the plain connection as `db` and in `ctx`, not an import transaction.
 */
export async function ensureImagery(
  db: Db,
  archive: Archive,
  transport: Transport,
  place: ImageryPlace,
  ctx: CallContext,
  cfg: ImagesConfig = getConfig().images,
): Promise<ImagerySet> {
  const wide = wideWindow(place.lon, place.lat, cfg.window);
  let coreTiles: ImageryTileRef[] = [];
  let wideTiles: ImageryTileRef[] = [];
  for (const grid of aerialGrids(place, cfg)) {
    const refs = await ensureWmsTiles(db, archive, transport, grid.source, grid.cells, ctx, cfg);
    if (grid.source === "ktimatologio") coreTiles = refs;
    else wideTiles = refs;
  }

  const dem = cfg.sources.copernicus_dem;
  const demTiles: ImageryTileRef[] = [];
  if (covers(dem.countries, place.country)) {
    for (const name of demTileNames(wide)) {
      const { lon, lat } = demTileCorner(name);
      const ref = await ensureTile(db, archive, {
        source: "copernicus_dem",
        tileKey: name,
        bbox: [lon, lat, lon + 1, lat + 1],
        resolutionM: dem.resolutionM,
        ext: "tif",
        contentType: "image/tiff",
        meta: { ...dem, watermarked: false },
        download: () => fetchDemTile(transport, name, ctx, dem),
        isBlank: async () => false,
      });
      if (ref) demTiles.push(ref);
    }
  }

  const coreSource = coreTiles.length > 0 && coreTiles.some((t) => !t.blank) ? "ktimatologio" : null;
  return { core: coreTiles, wide: wideTiles, dem: demTiles, coreSource };
}
