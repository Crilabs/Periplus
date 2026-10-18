import { inArray } from "drizzle-orm";
import type { AreaConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { tileGeoObjects } from "@/lib/db/schema";
import { assignParents, assignTiles } from "@/lib/domain/gazetteer/hierarchy";
import { ensureFallbackNames } from "@/lib/domain/gazetteer/names";
import { areaTileIds } from "@/lib/domain/gazetteer/tiles-ensure";

export const HIERARCHY_STAGE = "gazetteer.hierarchy";

/**
 * Stage `gazetteer.hierarchy` (Spec 03, steps 6 and 7), in one transaction: parents, tile links, then the
 * German fallback names of the objects linked to the area's tiles.
 */
export async function buildHierarchy(
  db: Db,
  area: AreaConfig,
): Promise<{ updated: number; links: number; fallbackNames: number }> {
  return db.transaction(async (tx) => {
    const { updated } = await assignParents(tx, area.key);
    const { links } = await assignTiles(tx, area.key);
    const linked = await tx
      .selectDistinct({ id: tileGeoObjects.geoObjectId })
      .from(tileGeoObjects)
      .where(inArray(tileGeoObjects.tileId, areaTileIds(area)));
    const fallbackNames = await ensureFallbackNames(tx, linked.map((l) => l.id));
    return { updated, links, fallbackNames };
  });
}
