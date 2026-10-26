import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { assignParents, assignSeas, assignSubdivisions } from "@/lib/domain/gazetteer/hierarchy";
import { ensureSubdivisionTiles } from "@/lib/domain/gazetteer/tiles-ensure";
import type { Bbox } from "@/lib/domain/tiles";

/*
 * Moving the pilot from configured areas to subdivisions (spec 14 „Umstellung“), after `gazetteer.coarse` and
 * `subdivisions.build`. The pilot tiles are the tiles that carried an area (`tiles.area_id`, kept as legacy).
 * `snapshotPilot` records what the pilot consists of before and after; `migrateSubdivisions` backfills the subdivision
 * columns; `compareSnapshots` tells whether the pilot kept every place and fact.
 */

export type PilotTileSnapshot = {
  tileId: string;
  /** Places of the tile: id, public id and status, by id. */
  places: Array<{ id: string; publicId: string | null; status: string }>;
  /** Facts of the geo objects of those places and of the tile's linked objects, by id. */
  factIds: string[];
};

export type PilotSnapshot = { takenAt: string; tiles: PilotTileSnapshot[] };

/** Every pilot tile (a tile with an area) with its places and facts, in a stable order. */
export async function snapshotPilot(db: Db): Promise<PilotSnapshot> {
  const { rows } = await db.execute<{ tile_id: string; places: PilotTileSnapshot["places"] | null; fact_ids: string[] | null }>(sql`
    with pilot as (select t.id from tiles t where t.area_id is not null),
    objects as (
      select p.id as tile_id, o.geo_object_id from pilot p
      cross join lateral (
        select pl.geo_object_id from places pl where pl.tile_id = p.id
        union
        select tg.geo_object_id from tile_geo_objects tg where tg.tile_id = p.id
      ) o
    )
    select p.id as tile_id,
      (select json_agg(json_build_object('id', pl.id, 'publicId', pl.public_id, 'status', pl.status) order by pl.id)
       from places pl where pl.tile_id = p.id) as places,
      (select array_agg(f.id::text order by f.id) from facts f where f.geo_object_id in (select o.geo_object_id from objects o where o.tile_id = p.id)) as fact_ids
    from pilot p
    order by p.id
  `);
  return {
    takenAt: new Date().toISOString(),
    tiles: rows.map((r) => ({ tileId: r.tile_id, places: r.places ?? [], factIds: r.fact_ids ?? [] })),
  };
}

/** The differences between two snapshots (ignoring `takenAt`), one German line each; empty when the pilot is unchanged. */
export function compareSnapshots(before: PilotSnapshot, after: PilotSnapshot): string[] {
  const problems: string[] = [];
  const afterTiles = new Map(after.tiles.map((t) => [t.tileId, t]));
  for (const b of before.tiles) {
    const a = afterTiles.get(b.tileId);
    if (!a) {
      problems.push(`Kachel ${b.tileId} fehlt nachher`);
      continue;
    }
    const diff = (label: string, x: string[], y: string[]) => {
      const missing = x.filter((v) => !y.includes(v));
      const added = y.filter((v) => !x.includes(v));
      if (missing.length > 0) problems.push(`Kachel ${b.tileId}: ${label} fehlen nachher: ${missing.join(", ")}`);
      if (added.length > 0) problems.push(`Kachel ${b.tileId}: ${label} neu: ${added.join(", ")}`);
    };
    diff("Orte", b.places.map((p) => `${p.id}/${p.publicId ?? "-"}/${p.status}`), a.places.map((p) => `${p.id}/${p.publicId ?? "-"}/${p.status}`));
    diff("Facts", b.factIds, a.factIds);
  }
  for (const a of after.tiles) if (!before.tiles.some((b) => b.tileId === a.tileId)) problems.push(`Kachel ${a.tileId} ist nachher neu Pilotkachel`);
  return problems;
}

export type MigrationResult = { tiles: number; objects: number; seas: number; parents: number; comparison: number; seabed: number };

/**
 * Backfills the subdivision columns over the pilot tiles; idempotent (a second run writes nothing but the tile labels
 * it recomputes unchanged): the tiles of every subdivision meeting a pilot tile (`ensureSubdivisionTiles`), then over
 * the pilot box the subdivision, sea and parent of every valid object (in that order: the parent rules read the
 * subdivision), `comparison_set.subdivision_id` from the place's geo object, and `seabed_polygons.subdivision_key` of
 * polygons still keyed by an area, from the subdivision containing them. No place, fact or profile is touched.
 */
export async function migrateSubdivisions(db: Db): Promise<MigrationResult> {
  const { rows: boxRows } = await db.execute<{ w: number | null; s: number | null; e: number | null; n: number | null }>(sql`
    select ST_XMin(x) as w, ST_YMin(x) as s, ST_XMax(x) as e, ST_YMax(x) as n
    from (select ST_Extent(bbox)::geometry as x from tiles where area_id is not null) b
  `);
  const box = boxRows[0];
  if (!box || box.w === null) return { tiles: 0, objects: 0, seas: 0, parents: 0, comparison: 0, seabed: 0 };
  const bbox: Bbox = [Number(box.w), Number(box.s), Number(box.e), Number(box.n)];

  const { rows: subs } = await db.execute<{ id: string }>(sql`
    select distinct s.id from subdivisions s
    join tiles t on t.area_id is not null and ST_Intersects(t.bbox, s.geom) and not ST_Touches(t.bbox, s.geom)
    where s.valid_to is null and s.status = 'active'
    order by s.id
  `);
  let tiles = 0;
  for (const s of subs) tiles += (await ensureSubdivisionTiles(db, s.id)).tiles;

  const objects = await assignSubdivisions(db, bbox);
  const seas = await assignSeas(db, bbox);
  const { updated: parents } = await assignParents(db, bbox);

  const comparison = await db.execute(sql`
    update comparison_set c set subdivision_id = o.subdivision_id
    from places p join geo_objects o on o.id = p.geo_object_id
    where p.id = c.place_id and o.subdivision_id is not null and c.subdivision_id is distinct from o.subdivision_id
  `);
  const seabed = await db.execute(sql`
    update seabed_polygons sp set subdivision_key = s.key
    from subdivisions s
    where s.valid_to is null and ST_Contains(s.geom, ST_PointOnSurface(sp.geom))
      and not exists (select 1 from subdivisions k where k.key = sp.subdivision_key and k.valid_to is null)
  `);
  return { tiles, objects, seas, parents, comparison: comparison.rowCount ?? 0, seabed: seabed.rowCount ?? 0 };
}
