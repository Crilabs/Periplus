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
} from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
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
