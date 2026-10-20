import { and, desc, eq, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Polygon, MultiPolygon } from "geojson";
import { getConfig, type SubdivisionsConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, subdivisions } from "@/lib/db/schema";
import { newPublicId } from "@/lib/domain/ids";
import { addNames, isGreek, transliterateElot743 } from "./names";

/*
 * Coast sections (spec 04, spec 14): named stretches of coast configured per subdivision
 * (`subdivisions.overrides[key].coastSections`), kept as geo objects of type `coast_section` below the subdivision's
 * geo object.
 */

type ConfigObject = {
  configKey: string;
  type: "coast_section";
  polygon: Polygon | MultiPolygon;
  names: Record<string, string>;
  parentId: string;
};

/**
 * Creates or updates the coast sections of the subdivision `subdivisionKey` from
 * `subdivisions.overrides[key].coastSections` (`type coast_section`, `rg_…`, `config_key "<key>/<section>"`, parent = the
 * subdivision's geo object). Geometry and parent are written only when they changed, so an unchanged rerun writes no
 * history; config names are `origin manual`, and a manual name no longer configured is ended. Sections no longer
 * configured are ended (`valid_to`); a key configured again revives its object. Returns `config_key → id`; throws for an
 * unknown subdivision. `cfg`: the subdivisions configuration (tests pass a changed one).
 */
export async function syncCoastSections(
  db: Db,
  subdivisionKey: string,
  cfg: SubdivisionsConfig = getConfig().subdivisions,
): Promise<Map<string, string>> {
  return db.transaction(async (tx) => {
    const [sub] = await tx
      .select({ geoObjectId: subdivisions.geoObjectId })
      .from(subdivisions)
      .where(and(eq(subdivisions.key, subdivisionKey), isNull(subdivisions.validTo)));
    if (!sub) throw new Error(`Unknown subdivision ${subdivisionKey}`);
    const sections = cfg.overrides[subdivisionKey]?.coastSections ?? [];
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

async function syncObject(db: Db, o: ConfigObject): Promise<string> {
  const geom = geomFromGeoJson(o.polygon);
  let [existing] = await db
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(and(eq(geoObjects.configKey, o.configKey), isNull(geoObjects.validTo)));
  if (!existing) {
    // configured again after `syncCoastSections` ended it: the same object and public id come back
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
    const parentChanged = sql`${geoObjects.parentId} is distinct from ${o.parentId}`;
    await db
      .update(geoObjects)
      .set({ geom: sql`${geom}`, parentId: o.parentId })
      .where(and(eq(geoObjects.id, id), sql`(not ST_OrderingEquals(${geoObjects.geom}, ${geom}) or ${parentChanged})`));
  } else {
    const [row] = await db
      .insert(geoObjects)
      .values({
        type: o.type,
        origin: "manual",
        configKey: o.configKey,
        publicId: newPublicId("rg"),
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
