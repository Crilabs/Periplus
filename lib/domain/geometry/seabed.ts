import { sql } from "drizzle-orm";
import type { Geometry, MultiPolygon, Polygon } from "geojson";
import type { DatasetsConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import type { SeabedType } from "@/lib/db/schema/geo";
import type { Bbox } from "@/lib/domain/tiles";

export type { SeabedType };

export type SeabedFeature = {
  substrate: SeabedType;
  habitat: string | null;
  sourceRef: string;
  geometry: Polygon | MultiPolygon;
};

export type SeabedShares = {
  /** Descending by share; shares rounded to 0.01, zeros dropped, sum exactly 1 (empty without coverage). */
  shares: Array<{ type: SeabedType; share: number }>;
  /** Covered area / area, 0–1. */
  coverage: number;
  /** Dataset versions of the polygons touching the area, sorted. */
  versions: string[];
};

/**
 * Seabed type of one source feature: `weed` when any `habitatFields` value contains one of the
 * `weedPatterns` (case-insensitive), else `substrateMap[props[substrateField]]`, else null.
 */
export function classifySeabed(props: Record<string, unknown>, cfg: DatasetsConfig["seabed"]): SeabedType | null {
  const patterns = cfg.weedPatterns.map((p) => p.toLowerCase());
  for (const field of cfg.habitatFields) {
    const value = props[field];
    if (typeof value === "string" && patterns.some((p) => value.toLowerCase().includes(p))) return "weed";
  }
  const substrate = props[cfg.substrateField];
  if (typeof substrate !== "string" || !Object.hasOwn(cfg.substrateMap, substrate)) return null;
  return cfg.substrateMap[substrate] ?? null;
}

/**
 * Replaces the `seabed_polygons` of `subdivisionKey` in one transaction: every feature made valid, cut to `box`
 * and split into its polygons (parts outside the box or without area are dropped).
 */
export async function replaceSeabed(
  db: Db,
  input: { subdivisionKey: string; datasetVersion: string; box: Bbox; features: SeabedFeature[] },
): Promise<{ inserted: number }> {
  const [west, south, east, north] = input.box;
  const features = input.features.map((f) => ({
    substrate: f.substrate,
    habitat: f.habitat,
    source_ref: f.sourceRef,
    geometry: f.geometry,
  }));
  return db.transaction(async (tx) => {
    await tx.execute(sql`delete from seabed_polygons where subdivision_key = ${input.subdivisionKey}`);
    if (features.length === 0) return { inserted: 0 };
    const { rows } = await tx.execute<{ id: string }>(sql`
      with box as (select ST_MakeEnvelope(${west}::float8, ${south}::float8, ${east}::float8, ${north}::float8, 4326) as geom),
      src as (
        select f->>'substrate' as substrate, f->>'habitat' as habitat, f->>'source_ref' as source_ref,
               ST_MakeValid(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(f->'geometry'), 4326))) as geom
        from jsonb_array_elements(${JSON.stringify(features)}::jsonb) f
      ),
      parts as (
        select src.substrate, src.habitat, src.source_ref,
               (ST_Dump(ST_CollectionExtract(ST_Intersection(src.geom, box.geom), 3))).geom as geom
        from src, box
        where src.geom && box.geom
      )
      insert into seabed_polygons (id, substrate, habitat, source_ref, subdivision_key, dataset_version, geom)
      select gen_random_uuid(), substrate::seabed_type, habitat, source_ref, ${input.subdivisionKey}, ${input.datasetVersion}, geom
      from parts
      where not ST_IsEmpty(geom) and ST_Area(geom) > 0
      returning id`);
    return { inserted: rows.length };
  });
}

/**
 * Seabed shares inside `area`: per type the area of the union of its polygons ∩ `area` (polygons imported
 * for several subdivisions count once). Shares are relative to the summed type areas (= covered area when types
 * do not overlap), rounded to 0.01, zeros dropped; the largest absorbs the rounding rest so the sum is 1.
 * `coverage` = union of all polygons ∩ `area` / area.
 */
export async function seabedShares(db: Db, area: Geometry): Promise<SeabedShares> {
  const { rows } = await db.execute<{ substrate: SeabedType | null; area_m2: number; covered_m2: number; total_m2: number; versions: string[] | null }>(sql`
    with a as (select ST_MakeValid(${geomFromGeoJson(area)}) as geom),
    hits as (
      select s.substrate, s.dataset_version, ST_Intersection(s.geom, a.geom) as geom
      from seabed_polygons s, a
      where s.geom && a.geom and ST_Intersects(s.geom, a.geom)
    ),
    per_type as (
      select substrate, ST_Area(ST_Union(geom)::geography) as area_m2
      from hits group by substrate
    ),
    totals as (
      select coalesce((select ST_Area(ST_Union(geom)::geography) from hits), 0) as covered_m2,
             (select ST_Area(geom::geography) from a) as total_m2,
             (select array_agg(distinct dataset_version order by dataset_version) from hits) as versions
    )
    select p.substrate, coalesce(p.area_m2, 0) as area_m2, t.covered_m2, t.total_m2, t.versions
    from totals t left join per_type p on true`);

  const first = rows[0];
  const total = Number(first?.total_m2 ?? 0);
  const covered = Number(first?.covered_m2 ?? 0);
  const coverage = total > 0 ? Math.min(1, covered / total) : 0;
  const versions = first?.versions ?? [];
  const typed = rows
    .filter((r): r is typeof r & { substrate: SeabedType } => r.substrate !== null)
    .map((r) => ({ type: r.substrate, areaM2: Number(r.area_m2) }))
    .filter((r) => r.areaM2 > 0);
  const sum = typed.reduce((s, r) => s + r.areaM2, 0);
  if (sum <= 0) return { shares: [], coverage, versions };

  const largest = typed.reduce((max, r) => (r.areaM2 > max.areaM2 ? r : max));
  const rounded = typed
    .map((r) => ({ type: r.type, share: Math.round((r.areaM2 / sum) * 100) / 100 }))
    .filter((r) => r.share > 0 || r.type === largest.type);
  const rest = rounded.filter((r) => r.type !== largest.type).reduce((s, r) => s + r.share, 0);
  const shares = rounded
    .map((r) => (r.type === largest.type ? { type: r.type, share: Math.round((1 - rest) * 100) / 100 } : r))
    .sort((x, y) => y.share - x.share || x.type.localeCompare(y.type));
  return { shares, coverage, versions };
}
