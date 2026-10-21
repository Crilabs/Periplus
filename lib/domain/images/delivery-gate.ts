import { sql } from "drizzle-orm";
import type { ImagesConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { imageryTiles, placeImages, placeRenders } from "@/lib/db/schema";

/*
 * Which images may leave Periplus (spec 13): an image is delivered only when the delivery switch of every source its
 * render used is on (`images.delivery.<source>`, the cadastre stays off until the licence is confirmed in writing).
 */

/**
 * The sources whose delivery switch is not on, in input order and without repeats. A source without a switch (not
 * configured) counts as off.
 */
export function imageBlockedBy(sources: string[], cfg: ImagesConfig["delivery"]): string[] {
  const switches = cfg as Record<string, boolean | undefined>;
  return [...new Set(sources)].filter((source) => switches[source] !== true);
}

/** The attribution texts of the aerial (WMS) and terrain (COG) sources: what an image's attribution must name. */
export function imageAttributionTexts(cfg: Pick<ImagesConfig, "sources">): { aerial: string[]; terrain: string[] } {
  const sources = Object.values(cfg.sources);
  return {
    aerial: sources.filter((s) => s.kind === "wms").map((s) => s.attribution),
    terrain: sources.filter((s) => s.kind === "cog").map((s) => s.attribution),
  };
}

/**
 * The sources of the core, wide and DEM tiles of each image's render (`place_renders.imagery_tile_ids` and
 * `dem_tile_ids`), distinct and sorted; a blank tile (no coverage) is no source. Every given image has an entry, empty
 * for one without a render.
 */
export async function imageSources(db: Db, placeImageIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(placeImageIds.map((id) => [id, []]));
  if (placeImageIds.length === 0) return out;
  const { rows } = await db.execute<{ id: string; sources: string[] }>(sql`
    select i.id, coalesce(array_agg(distinct t.source::text order by t.source::text) filter (where t.id is not null), '{}') as sources
    from ${placeImages} i
    join ${placeRenders} r on r.id = i.render_id
    left join ${imageryTiles} t on t.id = any(r.imagery_tile_ids || r.dem_tile_ids) and not t.blank
    where i.id = any(${sql.param(placeImageIds)}::uuid[])
    group by i.id
  `);
  for (const r of rows) out.set(r.id, r.sources);
  return out;
}
