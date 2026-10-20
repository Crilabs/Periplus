import { inArray } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { tileGeoObjects } from "@/lib/db/schema";
import { assignParents, assignSeas, assignSubdivisions, assignTiles } from "@/lib/domain/gazetteer/hierarchy";
import { bufferBbox } from "@/lib/domain/gazetteer/land";
import { ensureFallbackNames } from "@/lib/domain/gazetteer/names";
import type { GazetteerScope } from "@/lib/domain/gazetteer/scope";
import { subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";

export const HIERARCHY_STAGE = "gazetteer.hierarchy";

/**
 * Stage `gazetteer.hierarchy` (Spec 03, steps 6 and 7; spec 14), in one transaction: subdivision (nearest land) and sea
 * of every object in the scope box plus `bboxBufferKm`, parents, tile links of the scope tiles, then the German
 * fallback names of the objects linked to those tiles.
 */
export async function buildHierarchy(
  db: Db,
  scope: GazetteerScope,
): Promise<{ subdivisions: number; seas: number; updated: number; links: number; fallbackNames: number }> {
  return db.transaction(async (tx) => {
    const box = bufferBbox(scope.bbox, getConfig().gazetteer.bboxBufferKm);
    const subdivisions = await assignSubdivisions(tx, box);
    const seas = await assignSeas(tx, box);
    const { updated } = await assignParents(tx, scope.bbox);
    const tileIds = await subdivisionTileIds(tx, scope.subdivisionId);
    const { links } = await assignTiles(tx, tileIds);
    const linked =
      tileIds.length === 0
        ? []
        : await tx
            .selectDistinct({ id: tileGeoObjects.geoObjectId })
            .from(tileGeoObjects)
            .where(inArray(tileGeoObjects.tileId, tileIds));
    const fallbackNames = await ensureFallbackNames(tx, linked.map((l) => l.id));
    return { subdivisions, seas, updated, links, fallbackNames };
  });
}
