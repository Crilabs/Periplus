import { and, eq, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Polygon, MultiPolygon } from "geojson";
import type { AreaConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects } from "@/lib/db/schema";
import { newPublicId } from "@/lib/domain/ids";
import type { Bbox } from "@/lib/domain/tiles";
import { addNames } from "./names";

/** Bounding box of a polygon's outer rings. */
export function polygonBbox(polygon: AreaConfig["polygon"]): Bbox {
  const rings = polygon.type === "Polygon" ? [polygon.coordinates] : polygon.coordinates;
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings) {
    for (const [x, y] of ring[0]) {
      west = Math.min(west, x);
      east = Math.max(east, x);
      south = Math.min(south, y);
      north = Math.max(north, y);
    }
  }
  return [west, south, east, north];
}

/** The area's bounding box: its polygon's box, widened to cover the configured `tileBbox`. */
export function areaBbox(area: AreaConfig): Bbox {
  const box = polygonBbox(area.polygon);
  if (!area.tileBbox) return box;
  const [w, s, e, n] = area.tileBbox;
  return [Math.min(box[0], w), Math.min(box[1], s), Math.max(box[2], e), Math.max(box[3], n)];
}

type ConfigObject = {
  configKey: string;
  type: "area" | "coast_section";
  polygon: Polygon | MultiPolygon;
  names: Record<string, string>;
  parentId: string | null;
};

/**
 * Creates or updates the `geo_objects` of the configured areas (`type area`, `ar_…`) and their coast
 * sections (`type coast_section`, `rg_…`, `config_key "<area>/<section>"`, parent = the area).
 * Geometry and parent are only written when they changed, so an unchanged rerun writes no history.
 * Config names are `origin manual`; a manual name no longer in the config is ended (`valid_to`).
 * Returns `config_key → id`.
 */
export async function syncAreas(db: Db, areas: AreaConfig[]): Promise<Map<string, string>> {
  return db.transaction(async (tx) => {
    const ids = new Map<string, string>();
    for (const area of areas) {
      const areaId = await syncObject(tx, {
        configKey: area.key,
        type: "area",
        polygon: area.polygon,
        names: area.names,
        parentId: null,
      });
      ids.set(area.key, areaId);
      for (const section of area.coastSections) {
        const configKey = `${area.key}/${section.key}`;
        ids.set(
          configKey,
          await syncObject(tx, {
            configKey,
            type: "coast_section",
            polygon: section.polygon,
            names: section.names,
            parentId: areaId,
          }),
        );
      }
    }
    return ids;
  });
}

async function syncObject(db: Db, o: ConfigObject): Promise<string> {
  const geom = geomFromGeoJson(o.polygon);
  const [existing] = await db
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(and(eq(geoObjects.configKey, o.configKey), isNull(geoObjects.validTo)));

  let id: string;
  if (existing) {
    id = existing.id;
    await db
      .update(geoObjects)
      .set({ geom: sql`${geom}`, parentId: o.parentId })
      .where(
        and(
          eq(geoObjects.id, id),
          sql`(not ST_OrderingEquals(${geoObjects.geom}, ${geom}) or ${geoObjects.parentId} is distinct from ${o.parentId})`,
        ),
      );
  } else {
    const [row] = await db
      .insert(geoObjects)
      .values({
        type: o.type,
        origin: "manual",
        configKey: o.configKey,
        publicId: newPublicId(o.type === "area" ? "ar" : "rg"),
        parentId: o.parentId,
        geom: sql`${geom}`,
      })
      .returning({ id: geoObjects.id });
    id = row!.id;
  }

  await endStaleManualNames(db, id, o.names);
  await addNames(
    db,
    id,
    Object.entries(o.names).map(([language, name]) => ({ name, language, origin: "manual", isPreferred: true })),
  );
  return id;
}

/**
 * Ends (`valid_to`) the valid manual names the config no longer lists. Transliterations derived from an
 * ended Greek name stay valid: the same row may stem from another source's identical name.
 */
async function endStaleManualNames(db: Db, id: string, names: Record<string, string>): Promise<void> {
  const configured = Object.entries(names).map(([language, name]) => ({ language, name: name.trim().replace(/\s+/g, " ") }));
  await db
    .update(geoNames)
    .set({ validTo: sql`current_date` })
    .where(
      and(
        eq(geoNames.geoObjectId, id),
        eq(geoNames.origin, "manual"),
        isNull(geoNames.validTo),
        or(
          notInArray(geoNames.language, configured.map((n) => n.language)),
          ...configured.map((n) => and(eq(geoNames.language, n.language), ne(geoNames.name, n.name))),
        ),
      ),
    );
}
