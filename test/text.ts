import { eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  chunks,
  documents,
  documentVersions,
  extractionRuns,
  geoObjects,
  mentions,
  runs,
  sources,
  tileGeoObjects,
  tiles,
  type GeoObjectType,
} from "@/lib/db/schema";
import { addNames } from "@/lib/domain/gazetteer/names";
import { newId } from "@/lib/domain/ids";
import { tileBbox } from "@/lib/domain/tiles";
import type { Db } from "@/lib/db/client";

/*
 * Fixtures for text-pipeline tests (M4). Every row is meant for `withRollback`: append-only rows (mentions,
 * facts, routes) and stable rows (sources, geo objects) must never be committed by a test. Sources use
 * `<uuid>.test.invalid` domains, geo objects sit at 21.0° E / 35.2° N, outside the pilot box.
 */

export const CHUNK_TEXT = "Good holding in sand, well sheltered from the meltemi.";

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

/** A source, a document, one version and one chunk with `CHUNK_TEXT`. */
export async function insertTestChunk(tx: Db): Promise<{ sourceId: string; versionId: string; chunkId: string }> {
  const sourceId = await insertTestSource(tx);
  const url = `https://${newId()}.test.invalid/page`;
  const [doc] = await tx
    .insert(documents)
    .values({ sourceId, url, urlNormalized: url, docType: "trip_report" })
    .returning({ id: documents.id });
  const [version] = await tx
    .insert(documentVersions)
    .values({
      documentId: doc!.id,
      fetchedAt: new Date("2026-10-19T10:00:00Z"),
      contentHash: "c1",
      rawHash: "r1",
      rawKey: `archive/${doc!.id}/raw.html`,
      mdKey: `archive/${doc!.id}/raw.md`,
      observedAt: "2026-10-19",
      observedAtBasis: "fetched",
      docType: "trip_report",
      converter: "local",
      charCount: CHUNK_TEXT.length,
    })
    .returning({ id: documentVersions.id });
  const [chunk] = await tx
    .insert(chunks)
    .values({
      documentVersionId: version!.id,
      ordinal: 0,
      text: CHUNK_TEXT,
      textNormalized: CHUNK_TEXT,
      textHash: "t1",
      charStart: 0,
      charEnd: CHUNK_TEXT.length,
      wordCount: 9,
    })
    .returning({ id: chunks.id });
  return { sourceId, versionId: version!.id, chunkId: chunk!.id };
}

export async function insertTestExtractionRun(
  tx: Db,
  values: Partial<PgInsertValue<typeof extractionRuns>> = {},
): Promise<string> {
  const [row] = await tx
    .insert(extractionRuns)
    .values({
      task: "extract-facts",
      model: "claude-sonnet-5-5",
      promptVersion: 1,
      factSchemaVersion: "v2",
      runId: values.runId ?? (await insertTestRun(tx)),
      ...values,
    })
    .returning({ id: extractionRuns.id });
  return row!.id;
}

export type TestMention = { mentionId: string; versionId: string; chunkId: string; geoObjectId: string };

/** A deterministic mention of a new geo object in a new chunk; `values` override the mention columns. */
export async function insertTestMention(
  tx: Db,
  values: Partial<PgInsertValue<typeof mentions>> = {},
): Promise<TestMention> {
  const { versionId, chunkId } = await insertTestChunk(tx);
  const geoObjectId = await insertTestGeoObject(tx);
  const [row] = await tx
    .insert(mentions)
    .values({
      documentVersionId: versionId,
      chunkId,
      geoObjectId,
      surface: "Good",
      charStart: 0,
      charEnd: 4,
      observedAt: "2026-10-19",
      confidence: 1,
      matchKind: "deterministic",
      matchScore: 1,
      ...values,
    })
    .returning({ id: mentions.id });
  return { mentionId: row!.id, versionId, chunkId, geoObjectId };
}

/** A tile of the synthetic test grid around 21.0° E / 35.2° N (`q025:<col>:<row>`), with an optional label area. */
export async function insertTestTile(tx: Db, id: string, areaId: string | null = null): Promise<string> {
  const [w, s, e, n] = tileBbox(id);
  await tx
    .insert(tiles)
    .values({ id, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, areaId, hasCoast: true })
    .onConflictDoNothing();
  return id;
}

export type TestNamedObject = {
  type: GeoObjectType;
  names: Array<{ name: string; language?: string }>;
  lon: number;
  lat: number;
  /** Tiles the object lies in (`tile_geo_objects`); they must exist. */
  tiles?: string[];
  parentId?: string | null;
  configKey?: string;
};

/** A geo object with its names (incl. transliterations, via `addNames`) and its tile assignments. */
export async function insertNamedObject(tx: Db, o: TestNamedObject): Promise<string> {
  const id = await insertTestGeoObject(tx, {
    type: o.type,
    geom: geomFromGeoJson({ type: "Point", coordinates: [o.lon, o.lat] }),
    parentId: o.parentId ?? null,
    configKey: o.configKey ?? null,
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
 * A new document version whose chunks hold `texts` (one chunk each, `carried` maps a chunk index to the chunk it is
 * carried over from). `documentId` adds the version to an existing document; the version becomes current.
 */
export async function insertTestVersion(
  tx: Db,
  texts: string[],
  opts: { sourceId?: string; documentId?: string; carried?: Record<number, string>; observedAt?: string } = {},
): Promise<{ sourceId: string; documentId: string; versionId: string; chunkIds: string[] }> {
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
      fetchedAt: new Date("2026-10-19T10:00:00Z"),
      contentHash: newId(),
      rawHash: "r",
      rawKey: `archive/${documentId}/${newId()}.raw.html`,
      mdKey: `archive/${documentId}/${newId()}.md`,
      observedAt: opts.observedAt ?? "2026-10-19",
      observedAtBasis: "fetched",
      docType: "trip_report",
      converter: "local",
      charCount: full.length,
    })
    .returning({ id: documentVersions.id });
  await tx.update(documents).set({ currentVersionId: version!.id }).where(eq(documents.id, documentId));
  const chunkIds: string[] = [];
  let offset = 0;
  for (const [i, text] of texts.entries()) {
    const [chunk] = await tx
      .insert(chunks)
      .values({
        documentVersionId: version!.id,
        ordinal: i,
        text,
        textNormalized: text,
        textHash: `t${i}`,
        charStart: offset,
        charEnd: offset + text.length,
        wordCount: text.split(/\s+/).length,
        carriedFromChunkId: opts.carried?.[i] ?? null,
      })
      .returning({ id: chunks.id });
    chunkIds.push(chunk!.id);
    offset += text.length + 2;
  }
  return { sourceId, documentId, versionId: version!.id, chunkIds };
}
