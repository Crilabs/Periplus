import { eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { geomFromGeoJson } from "@/lib/db/geometry";
import type { PoiCategory } from "@/lib/db/schema/geo";
import type { DocType } from "@/lib/db/schema/sources";
import {
  documents,
  documentVersions,
  geoObjects,
  runs,
  sources,
  subdivisions,
  tileGeoObjects,
  tiles,
  type GeoObjectType,
} from "@/lib/db/schema";
import { addNames } from "@/lib/domain/gazetteer/names";
import { newId, newPublicId } from "@/lib/domain/ids";
import { tileBbox } from "@/lib/domain/tiles";
import type { Db } from "@/lib/db/client";

/*
 * Shared fixtures. Every row is meant for `withRollback`; a test must not commit it. Sources use
 * `<uuid>.test.invalid` domains, geo objects sit at 21.0° E / 35.2° N, outside the pilot box.
 */

export async function insertTestRun(tx: Db): Promise<string> {
  const [row] = await tx
    .insert(runs)
    .values({ kind: "reprocess", scopeType: "system", scopeId: "test", triggeredBy: "test" })
    .returning({ id: runs.id });
  return row!.id;
}

export async function insertTestGeoObject(
  tx: Db,
  values: Partial<PgInsertValue<typeof geoObjects>> = {},
): Promise<string> {
  const [row] = await tx
    .insert(geoObjects)
    .values({ type: "bay", origin: "osm", geom: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] }), ...values })
    .returning({ id: geoObjects.id });
  return row!.id;
}

export async function insertTestSource(tx: Db): Promise<string> {
  const [row] = await tx
    .insert(sources)
    .values({
      domain: `${newId()}.test.invalid`,
      name: "Test source",
      type: "trip_report",
      weight: 0.6,
      crawlRules: { startUrls: [] },
      origin: "manual",
    })
    .returning({ id: sources.id });
  return row!.id;
}

/**
 * A tile of the synthetic test grid around 21.0° E / 35.2° N (`q025:<col>:<row>`), with an optional label area and
 * label subdivision. A tile that already exists (committed by some other test) with another label area fails loudly
 * instead of skewing the test.
 */
export async function insertTestTile(tx: Db, id: string, areaId: string | null = null, subdivisionId: string | null = null): Promise<string> {
  const [w, s, e, n] = tileBbox(id);
  await tx
    .insert(tiles)
    .values({ id, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, areaId, subdivisionId, hasCoast: true })
    .onConflictDoNothing();
  const [row] = await tx.select({ areaId: tiles.areaId }).from(tiles).where(eq(tiles.id, id));
  if (row?.areaId !== areaId) throw new Error(`test tile ${id} exists with area ${row?.areaId ?? "none"}, expected ${areaId ?? "none"}`);
  return id;
}

/**
 * A subdivision over the box `[west, south, east, north]` (polygon and land) with its admin region object (a valid
 * subdivision's `geo_object_id`). Use a key no committed row has (`XT-...`), and boxes outside the pilot box.
 */
export async function insertTestSubdivision(
  tx: Db,
  key: string,
  box: [number, number, number, number],
  o: { country?: string; status?: "active" | "excluded" } = {},
): Promise<{ id: string; geoObjectId: string }> {
  const polygon = sql`ST_Multi(ST_MakeEnvelope(${box[0]}, ${box[1]}, ${box[2]}, ${box[3]}, 4326))`;
  const [region] = await tx
    .insert(geoObjects)
    .values({ type: "admin_region", origin: "manual", configKey: `${key}/region`, geom: polygon })
    .returning({ id: geoObjects.id });
  const [row] = await tx
    .insert(subdivisions)
    .values({
      publicId: newPublicId("sd"),
      key,
      country: o.country ?? "GR",
      geoObjectId: region!.id,
      geom: polygon,
      landGeom: polygon,
      status: o.status ?? "active",
    })
    .returning({ id: subdivisions.id });
  return { id: row!.id, geoObjectId: region!.id };
}

export type TestNamedObject = {
  /** A fixed id (else a new one). */
  id?: string;
  type: GeoObjectType;
  names: Array<{ name: string; language?: string }>;
  lon: number;
  lat: number;
  /** Tiles the object lies in (`tile_geo_objects`); they must exist. */
  tiles?: string[];
  parentId?: string | null;
  configKey?: string;
  /** The subdivision the object belongs to (`geo_objects.subdivision_id`, nearest land). */
  subdivisionId?: string | null;
  /** The POI category (`poi` objects only). */
  category?: PoiCategory | null;
};

/** A geo object with its names (incl. transliterations, via `addNames`) and its tile assignments. */
export async function insertNamedObject(tx: Db, o: TestNamedObject): Promise<string> {
  const id = await insertTestGeoObject(tx, {
    ...(o.id ? { id: o.id } : {}),
    type: o.type,
    geom: geomFromGeoJson({ type: "Point", coordinates: [o.lon, o.lat] }),
    parentId: o.parentId ?? null,
    configKey: o.configKey ?? null,
    ...(o.subdivisionId !== undefined ? { subdivisionId: o.subdivisionId } : {}),
    category: o.category ?? null,
  });
  await addNames(
    tx,
    id,
    o.names.map((n) => ({ name: n.name, language: n.language ?? "en", origin: "osm" as const })),
  );
  if (o.tiles && o.tiles.length > 0) {
    await tx.insert(tileGeoObjects).values(o.tiles.map((tileId) => ({ tileId, geoObjectId: id })));
  }
  return id;
}

/**
 * A new document version (one per call; `texts` only sizes `char_count`). `documentId` adds the version to an existing
 * document; the version becomes current. `docType` is the version's fetch-time type (default `trip_report`).
 */
export async function insertTestVersion(
  tx: Db,
  texts: string[],
  opts: { sourceId?: string; documentId?: string; observedAt?: string; fetchedAt?: Date; docType?: DocType } = {},
): Promise<{ sourceId: string; documentId: string; versionId: string }> {
  const sourceId = opts.sourceId ?? (await insertTestSource(tx));
  let documentId = opts.documentId;
  if (!documentId) {
    const url = `https://${newId()}.test.invalid/page`;
    const [doc] = await tx.insert(documents).values({ sourceId, url, urlNormalized: url, docType: "trip_report" }).returning({ id: documents.id });
    documentId = doc!.id;
  }
  const full = texts.join("\n\n");
  const [version] = await tx
    .insert(documentVersions)
    .values({
      documentId,
      fetchedAt: opts.fetchedAt ?? new Date("2026-10-19T10:00:00Z"),
      contentHash: newId(),
      rawHash: "r",
      rawKey: `archive/${documentId}/${newId()}.raw.html`,
      mdKey: `archive/${documentId}/${newId()}.md`,
      observedAt: opts.observedAt ?? "2026-10-19",
      observedAtBasis: "fetched",
      docType: opts.docType ?? "trip_report",
      converter: "local",
      charCount: full.length,
    })
    .returning({ id: documentVersions.id });
  await tx.update(documents).set({ currentVersionId: version!.id }).where(eq(documents.id, documentId));
  return { sourceId, documentId, versionId: version!.id };
}
