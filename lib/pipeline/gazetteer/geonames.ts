import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { GeonamesAltName, GeonamesRow, GeonamesSource } from "@/lib/adapters/geonames";
import { getConfig, type AreaConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, type GeoObjectType } from "@/lib/db/schema";
import { areaBbox } from "@/lib/domain/gazetteer/areas";
import { bufferBbox } from "@/lib/domain/gazetteer/land";
import { findMatch, resolveMergedByExternalId } from "@/lib/domain/gazetteer/merge";
import { addNames, isGreek, type NameDraft } from "@/lib/domain/gazetteer/names";
import { upsertGeoObject } from "@/lib/domain/gazetteer/store";
import { createLogger } from "@/lib/logger";

export const GEONAMES_STAGE = "gazetteer.geonames";

const log = createLogger("gazetteer.geonames");

/** Types matched together, as in `findMatch`. */
const ISLAND_GROUP: GeoObjectType[] = ["island", "islet"];

/**
 * Names with `origin geonames`: the main name (`el` when Greek, else `und`), the ASCII name as `en` only
 * when no `en` alternate name exists, then the alternate names with their language (`und` when empty).
 */
function rowNames(row: GeonamesRow, alternates: GeonamesAltName[]): NameDraft[] {
  const names: NameDraft[] = [{ name: row.name, language: isGreek(row.name) ? "el" : "und", origin: "geonames" }];
  if (row.asciiName && !alternates.some((a) => a.language === "en")) {
    names.push({ name: row.asciiName, language: "en", origin: "geonames" });
  }
  for (const a of alternates) {
    names.push({ name: a.name, language: a.language || "und", origin: "geonames", isPreferred: a.isPreferred });
  }
  return names;
}

/**
 * The valid object already carrying this GeoNames ID (lowest id), else the survivor of an object with this
 * ID that was merged away (e.g. into an object keeping its own GeoNames ID after a "same" review decision).
 */
async function byGeonamesId(db: Db, id: string): Promise<{ id: string; merged: boolean } | undefined> {
  const [row] = await db
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(and(eq(geoObjects.geonamesId, id), isNull(geoObjects.validTo)))
    .orderBy(asc(geoObjects.id))
    .limit(1);
  if (row) return { id: row.id, merged: false };
  const survivor = await resolveMergedByExternalId(db, "geonames_id", id);
  return survivor ? { id: survivor, merged: true } : undefined;
}

/** Sets `geonames_id` on an object that has none; false when it already carries another one. */
async function link(db: Db, id: string, geonamesId: string): Promise<boolean> {
  const updated = await db
    .update(geoObjects)
    .set({ geonamesId, updatedAt: sql`now()` })
    .where(and(eq(geoObjects.id, id), isNull(geoObjects.geonamesId)))
    .returning({ id: geoObjects.id });
  return updated.length > 0;
}

/** True when a valid, unmerged object of the type group lies within `radiusM` of the point. */
async function hasNeighbour(db: Db, type: GeoObjectType, row: GeonamesRow, radiusM: number): Promise<boolean> {
  const types = ISLAND_GROUP.includes(type) ? ISLAND_GROUP : [type];
  const { rows } = await db.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from geo_objects o
      where o.valid_to is null and o.merged_into_id is null and o.type in ${types}
        and ST_DWithin(o.geom::geography, ST_SetSRID(ST_MakePoint(${row.lon}, ${row.lat}), 4326)::geography, ${radiusM})
    ) as found
  `);
  return rows[0]!.found;
}

/**
 * Stage `gazetteer.geonames` (Spec 03, step 3): reads the GeoNames rows of every configured country in the
 * area box plus `bboxBufferKm` and their alternate names, then, in one transaction, per row of a configured
 * feature code: (1) an object with this `geonames_id` gets the names (for an object merged away with it,
 * its survivor gets them and counts as linked); (2) else a `same` match of `findMatch` within
 * `geonamesNewObjectRadiusM` that has no GeoNames ID yet is linked and gets the names; (3) else, when any
 * valid object of the same type group lies within that radius, the row is skipped (GeoNames only
 * supplements); otherwise a new point object with `origin geonames` is created.
 */
export async function importGeonames(
  db: Db,
  input: { area: AreaConfig; runId: string },
  deps: { source: GeonamesSource },
): Promise<{ linked: number; created: number; skipped: number; names: number }> {
  const { area } = input;
  const { gazetteer } = getConfig();
  const { countries, featureCodes } = gazetteer.geonames;
  const radiusM = gazetteer.merge.geonamesNewObjectRadiusM;
  const bbox = bufferBbox(areaBbox(area), gazetteer.bboxBufferKm);

  // Read outside the import transaction: a download must not hold it open.
  const rows: GeonamesRow[] = [];
  const alternates = new Map<string, GeonamesAltName[]>();
  for (const country of countries) {
    const countryRows = (await deps.source.rows(country, bbox)).filter((r) => featureCodes[r.featureCode]);
    rows.push(...countryRows);
    if (countryRows.length === 0) continue;
    for (const a of await deps.source.alternateNames(country, new Set(countryRows.map((r) => r.id)))) {
      alternates.set(a.geonameId, [...(alternates.get(a.geonameId) ?? []), a]);
    }
  }

  return db.transaction(async (tx) => {
    const result = { linked: 0, created: 0, skipped: 0, names: 0 };
    for (const row of rows) {
      const type = featureCodes[row.featureCode]!;
      const names = rowNames(row, alternates.get(row.id) ?? []);

      const known = await byGeonamesId(tx, row.id);
      if (known) {
        if (known.merged) result.linked++;
        result.names += await addNames(tx, known.id, names);
        continue;
      }

      const match = await findMatch(
        tx,
        { type, point: { lon: row.lon, lat: row.lat }, names: names.map((n) => n.name) },
        gazetteer.merge,
        { distanceM: radiusM },
      );
      if (match.kind === "same" && (await link(tx, match.id, row.id))) {
        result.linked++;
        result.names += await addNames(tx, match.id, names);
        continue;
      }

      if (await hasNeighbour(tx, type, row, radiusM)) {
        result.skipped++;
        continue;
      }

      const created = await upsertGeoObject(tx, {
        type,
        origin: "geonames",
        geonamesId: row.id,
        geometry: { type: "Point", coordinates: [row.lon, row.lat] },
        names,
      });
      if ("skipped" in created) {
        log.warn({ geonamesId: row.id, reason: created.skipped }, "skipped geonames row with unusable geometry");
        result.skipped++;
        continue;
      }
      result.created++;
      result.names += created.names;
    }
    return result;
  });
}
