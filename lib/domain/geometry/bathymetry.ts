import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

export type BathymetryImport = {
  /** GeoTIFF bytes in EPSG:4326. */
  bytes: Uint8Array;
  dataset: string;
  datasetVersion: string;
  resolutionM: number;
  /** Periplus tile the raster was fetched for. */
  tileId: string;
  /** True when the source holds elevation (negative below sea level); the sign is flipped to depth. */
  valueIsElevation: boolean;
};

/**
 * Replaces the `bathymetry` rows of (dataset, tileId) with the GeoTIFF cut into 256×256 raster tiles,
 * in one transaction. Stored values are depth in metres, positive in water: elevation sources are
 * negated (nodata stays nodata). The raster must be EPSG:4326.
 */
export async function importBathymetryRaster(db: Db, input: BathymetryImport): Promise<{ rasterTiles: number }> {
  const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  return db.transaction(async (tx) => {
    const { rows: meta } = await tx.execute<{ srid: number }>(sql`select ST_SRID(ST_FromGDALRaster(${bytes})) as srid`);
    const srid = Number(meta[0]!.srid);
    if (srid !== 4326) throw new Error(`bathymetry raster ${input.dataset}/${input.tileId} has SRID ${srid}, expected 4326`);

    await tx.execute(sql`delete from bathymetry where dataset = ${input.dataset} and tile_id = ${input.tileId}`);
    const source = input.valueIsElevation
      ? sql`ST_MapAlgebra(ST_FromGDALRaster(${bytes}), 1, '32BF', '-[rast]')`
      : sql`ST_FromGDALRaster(${bytes})`;
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into bathymetry (id, dataset, dataset_version, resolution_m, tile_id, rast)
      select gen_random_uuid(), ${input.dataset}, ${input.datasetVersion}, ${input.resolutionM}::real, ${input.tileId}, t.rast
      from (select ST_Tile(${source}, 1, 256, 256) as rast) t
      returning id`);
    return { rasterTiles: rows.length };
  });
}
