import { and, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Polygon, MultiPolygon } from "geojson";
import { getConfig, type AreaConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, subdivisions } from "@/lib/db/schema";
import { newPublicId } from "@/lib/domain/ids";
import type { Bbox } from "@/lib/domain/tiles";
import { addNames, isGreek, transliterateElot743 } from "./names";

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
  /** `undefined`: the parent is left alone (an area's sea is set by the hierarchy stage). */
  parentId?: string;
};

/**
 * Creates or updates the `geo_objects` of the configured areas (`type area`, `ar_…`) and their coast
 * sections (`type coast_section`, `rg_…`, `config_key "<area>/<section>"`, parent = the area). An area's
 * parent (its sea or gulf) is left to `assignParents`.
 * Geometry and parent are only written when they changed, so an unchanged rerun writes no history.
 * Config names are `origin manual`; a manual name no longer in the config is ended (`valid_to`). An object ended
 * because its key was no longer configured is revived. Ending such objects is `endUnconfiguredAreas`.
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

/**
 * Creates or updates the coast sections of the subdivision `subdivisionKey` from
 * `subdivisions.overrides[key].coastSections` (`type coast_section`, `rg_…`, `config_key "<key>/<section>"`, parent = the
 * subdivision's geo object). Like `syncAreas` it writes geometry and parent only when they changed. Sections no longer
 * configured are ended (`valid_to`); a key configured again revives its object. Returns `config_key → id`; throws for an
 * unknown subdivision.
 */
export async function syncCoastSections(db: Db, subdivisionKey: string): Promise<Map<string, string>> {
  return db.transaction(async (tx) => {
    const [sub] = await tx
      .select({ geoObjectId: subdivisions.geoObjectId })
      .from(subdivisions)
      .where(and(eq(subdivisions.key, subdivisionKey), isNull(subdivisions.validTo)));
    if (!sub) throw new Error(`Unknown subdivision ${subdivisionKey}`);
    const sections = getConfig().subdivisions.overrides[subdivisionKey]?.coastSections ?? [];
    const ids = new Map<string, string>();
    for (const section of sections) {
      const configKey = `${subdivisionKey}/${section.key}`;
      ids.set(
        configKey,
        await syncObject(tx, {
          configKey,
          type: "coast_section",
          polygon: section.polygon,
          names: section.names,
          parentId: sub.geoObjectId,
        }),
      );
    }
    await tx
      .update(geoObjects)
      .set({ validTo: sql`current_date`, updatedAt: sql`now()` })
      .where(
        and(
          eq(geoObjects.type, "coast_section"),
          isNull(geoObjects.validTo),
          sql`${geoObjects.configKey} like ${`${subdivisionKey}/%`}`,
          ids.size > 0 ? notInArray(geoObjects.configKey, [...ids.keys()]) : undefined,
        ),
      );
    return ids;
  });
}

/**
 * Ends (`valid_to = current_date`) the valid areas and coast sections whose config key is no longer configured, so the
 * next package reports a removed coast section as `removed` and `GET /areas` no longer lists a removed area
 * (gesamt-review DAT-4). Takes the whole configuration (the tiles stage passes `getConfig().areas`); `among` limits the
 * keys considered (tests). Returns the ended keys, sorted. A key configured again revives its object (`syncObject`).
 */
export async function endUnconfiguredAreas(db: Db, areas: AreaConfig[], opts: { among?: string[] } = {}): Promise<string[]> {
  const configured = areas.flatMap((a) => [a.key, ...a.coastSections.map((s) => `${a.key}/${s.key}`)]);
  if (opts.among?.length === 0) return [];
  const rows = await db
    .update(geoObjects)
    .set({ validTo: sql`current_date`, updatedAt: sql`now()` })
    .where(
      and(
        isNotNull(geoObjects.configKey),
        isNull(geoObjects.validTo),
        inArray(geoObjects.type, ["area", "coast_section"]),
        configured.length > 0 ? notInArray(geoObjects.configKey, configured) : undefined,
        opts.among ? inArray(geoObjects.configKey, opts.among) : undefined,
      ),
    )
    .returning({ configKey: geoObjects.configKey });
  return rows.map((r) => r.configKey!).sort();
}

async function syncObject(db: Db, o: ConfigObject): Promise<string> {
  const geom = geomFromGeoJson(o.polygon);
  let [existing] = await db
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(and(eq(geoObjects.configKey, o.configKey), isNull(geoObjects.validTo)));
  if (!existing) {
    // configured again after `endUnconfiguredAreas` ended it: the same object and public id come back
    const [ended] = await db
      .select({ id: geoObjects.id })
      .from(geoObjects)
      .where(and(eq(geoObjects.configKey, o.configKey), eq(geoObjects.type, o.type), isNull(geoObjects.mergedIntoId)))
      .orderBy(desc(geoObjects.validTo), desc(geoObjects.id))
      .limit(1);
    if (ended) {
      await db.update(geoObjects).set({ validTo: null, updatedAt: sql`now()` }).where(eq(geoObjects.id, ended.id));
      existing = ended;
    }
  }

  let id: string;
  if (existing) {
    id = existing.id;
    const parentChanged =
      o.parentId === undefined ? sql`false` : sql`${geoObjects.parentId} is distinct from ${o.parentId}`;
    await db
      .update(geoObjects)
      .set({ geom: sql`${geom}`, ...(o.parentId === undefined ? {} : { parentId: o.parentId }) })
      .where(and(eq(geoObjects.id, id), sql`(not ST_OrderingEquals(${geoObjects.geom}, ${geom}) or ${parentChanged})`));
  } else {
    const [row] = await db
      .insert(geoObjects)
      .values({
        type: o.type,
        origin: "manual",
        configKey: o.configKey,
        publicId: newPublicId(o.type === "area" ? "ar" : "rg"),
        parentId: o.parentId ?? null,
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
 * Ends (`valid_to`) the valid manual names the config no longer lists, and then every valid transliteration that no
 * Greek name still valid on the object or configured produces (the old form of a corrected `el` name, gesamt-review
 * W3-M-2). A transliteration another source's identical Greek name still produces stays.
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
  const greek = await db
    .select({ name: geoNames.name })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, id), eq(geoNames.script, "greek"), isNull(geoNames.validTo)));
  const produced = [...greek.map((r) => r.name), ...configured.map((n) => n.name).filter(isGreek)].map(transliterateElot743);
  await db
    .update(geoNames)
    .set({ validTo: sql`current_date` })
    .where(
      and(
        eq(geoNames.geoObjectId, id),
        eq(geoNames.origin, "transliteration"),
        isNull(geoNames.validTo),
        ...(produced.length > 0 ? [notInArray(geoNames.name, produced)] : []),
      ),
    );
}
