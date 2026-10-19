import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { computations, extractionUnits, facts, mentions, places, sources, type ComputationKind, type DocType } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { insertNamedObject, insertTestExtractionRun, insertTestRun, insertTestVersion } from "@/test/text";

/*
 * Fixtures for consolidation tests against the database: a place, sources, text facts of an active extraction run and
 * computations, inserted directly. Meant for `withRollback`; synthetic objects at 21.0° E / 35.2° N (outside the pilot
 * box), sources on `<uuid>.test.invalid`.
 */

const extractFacts = loadConfig("config").models.tasks["extract-facts"]!;
const QUOTE = "good holding in sand";

/** A geo object (bay) with a confirmed anchorage place. */
export async function insertPlace(db: Db, o: { lon?: number; lat?: number; name?: string } = {}): Promise<{ objectId: string; placeId: string }> {
  const lon = o.lon ?? 21.0;
  const lat = o.lat ?? 35.2;
  const objectId = await insertNamedObject(db, { type: "bay", names: [{ name: o.name ?? "Kolona" }], lon, lat });
  const [p] = await db
    .insert(places)
    .values({ geoObjectId: objectId, kind: "anchorage", status: "confirmed", position: geomFromGeoJson({ type: "Point", coordinates: [lon, lat] }) })
    .returning({ id: places.id });
  return { objectId, placeId: p!.id };
}

/** A source of `type` with `weight`. */
export async function insertSource(db: Db, type: DocType, weight: number): Promise<string> {
  const [row] = await db
    .insert(sources)
    .values({ domain: `${newId()}.test.invalid`, name: "Test source", type, weight, crawlRules: { startUrls: [] }, origin: "manual" })
    .returning({ id: sources.id });
  return row!.id;
}

/**
 * A text fact of the object: a new document of `sourceId` whose one chunk mentions it, a finished extraction run with
 * a done unit (the active run), and the fact with a verified quote. An `observedAt` other than the version's fetch
 * date (2026-10-19) is a stated observation date (`dateKnown`).
 */
export async function insertTextFact(
  db: Db,
  objectId: string,
  sourceId: string,
  f: { attribute: string; value: unknown; observedAt?: string; confidence?: number },
): Promise<string> {
  const observedAt = f.observedAt ?? "2026-10-19";
  const chunkText = `Kolona: ${QUOTE}.`;
  const v = await insertTestVersion(db, [chunkText], { sourceId });
  const [m] = await db
    .insert(mentions)
    .values({ documentVersionId: v.versionId, chunkId: v.chunkIds[0]!, geoObjectId: objectId, surface: "Kolona", charStart: 0, charEnd: 6, observedAt, confidence: 1, matchKind: "deterministic" })
    .returning({ id: mentions.id });
  const runId = await insertTestExtractionRun(db, {
    runId: await insertTestRun(db),
    model: extractFacts.model,
    promptVersion: extractFacts.promptVersion,
    purpose: "regular",
    status: "finished",
    startedAt: new Date("2026-10-18T10:00:00Z"),
  });
  await db.insert(extractionUnits).values({ extractionRunId: runId, documentVersionId: v.versionId, geoObjectId: objectId, part: 0, level: "place", mentionIds: [m!.id], chunkIds: [v.chunkIds[0]!], status: "done" });
  const start = chunkText.indexOf(QUOTE);
  const [row] = await db
    .insert(facts)
    .values({
      geoObjectId: objectId,
      attribute: f.attribute,
      value: f.value,
      mentionId: m!.id,
      quote: QUOTE,
      quoteVerified: true,
      quoteChunkId: v.chunkIds[0]!,
      quoteStart: start,
      quoteEnd: start + QUOTE.length,
      observedAt,
      confidence: f.confidence ?? 0.8,
      extractionRunId: runId,
      factSchemaVersion: "v2",
    })
    .returning({ id: facts.id });
  return row!.id;
}

/** A computation of `kind` with one fact per entry of `values` (confidence `confidence`). */
export async function insertComputation(
  db: Db,
  objectId: string,
  kind: ComputationKind,
  values: Record<string, unknown>,
  o: { confidence?: number; createdAt?: Date } = {},
): Promise<string> {
  const createdAt = o.createdAt ?? new Date("2026-10-01T10:00:00Z");
  const [c] = await db
    .insert(computations)
    .values({ geoObjectId: objectId, kind, inputs: values, inputsHash: newId(), outputs: {}, rulesVersion: "test", createdAt })
    .returning({ id: computations.id });
  await db.insert(facts).values(
    Object.entries(values).map(([attribute, value]) => ({
      geoObjectId: objectId,
      attribute,
      value,
      computationId: c!.id,
      observedAt: createdAt.toISOString().slice(0, 10),
      confidence: o.confidence ?? 0.55,
      factSchemaVersion: "v2",
    })),
  );
  return c!.id;
}
