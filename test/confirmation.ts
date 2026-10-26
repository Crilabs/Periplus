import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { documents, extractionUnits, geoObjects, mentions, places, placeWebsites, routes, routeStops, type DocType, type PlaceKind, type PlaceStatus } from "@/lib/db/schema";
import { insertExtraction, insertMention, insertMentionFact, insertPlace, insertSource, type TestMention } from "@/test/consolidation";
import { insertTestExtractionRun, insertTestRun, insertTestVersion } from "@/test/text";

/*
 * Fixtures for the confirmation by evidence (spec 17): places of a kind and status, berth facts from documents of a
 * type, route stops and pages bound to a place. Meant for `withRollback`; objects at 21.0° E / 35.2° N.
 */

/** The extraction model of the removed old pipeline: only the fixtures of its stored rows name it (N6). */
const extractFacts = { model: "claude-sonnet-5-5", promptVersion: 6 };

/** A place of `kind` and `status` (default a candidate anchorage) on a new bay, with OSM `tags`. */
export async function placeOf(
  tx: Db,
  o: { kind?: PlaceKind; status?: PlaceStatus; tags?: Record<string, string>; publicId?: string | null } = {},
): Promise<{ objectId: string; placeId: string }> {
  const p = await insertPlace(tx, { status: o.status ?? "candidate" });
  await tx.update(places).set({ kind: o.kind ?? "anchorage", publicId: o.publicId ?? null }).where(eq(places.id, p.placeId));
  if (o.tags) await tx.update(geoObjects).set({ tags: o.tags }).where(eq(geoObjects.id, p.objectId));
  return p;
}

export type EvidenceFact = { factId: string; documentId: string; versionId: string; sourceId: string };

/**
 * A text fact of the active extraction run on a new document of `sourceId` (default a new source) whose version has
 * type `docType` (default `trip_report`); default attribute `holding` = `good`.
 */
export async function factFrom(
  tx: Db,
  objectId: string,
  o: { docType?: DocType; sourceId?: string; attribute?: string; value?: unknown; observedAt?: string } = {},
): Promise<EvidenceFact> {
  const sourceId = o.sourceId ?? (await insertSource(tx, o.docType ?? "trip_report", 0.6));
  const m = await insertMention(tx, objectId, { sourceId, docType: o.docType ?? "trip_report", observedAt: o.observedAt });
  const factId = await insertMentionFact(tx, objectId, m, await insertExtraction(tx, objectId, m), {
    attribute: o.attribute ?? "holding",
    value: o.value ?? "good",
    observedAt: o.observedAt,
  });
  return { factId, documentId: m.documentId, versionId: m.versionId, sourceId };
}

/**
 * A route stop of the object in a document of type `docType` (default `trip_report`). `factSchema` is the schema version
 * of the extraction run holding the stop's (version, object) unit: the active one by default, `v2` for a unit only an
 * old run extracted.
 */
export async function routeStopOf(
  tx: Db,
  objectId: string,
  o: { docType?: DocType; sourceId?: string; factSchema?: string } = {},
): Promise<{ stopId: string; documentId: string; sourceId: string }> {
  const sourceId = o.sourceId ?? (await insertSource(tx, o.docType ?? "trip_report", 0.6));
  const m = await insertMention(tx, objectId, { sourceId, docType: o.docType ?? "trip_report", text: "We moored at Kolona: good holding in sand." });
  if (o.factSchema) {
    const runId = await insertTestExtractionRun(tx, {
      runId: await insertTestRun(tx),
      model: extractFacts.model,
      promptVersion: extractFacts.promptVersion,
      factSchemaVersion: o.factSchema,
      status: "finished",
      startedAt: new Date("2026-10-18T10:00:00Z"),
    });
    await tx.insert(extractionUnits).values({ extractionRunId: runId, documentVersionId: m.versionId, geoObjectId: objectId, part: 0, level: "place", mentionIds: [m.mentionId], chunkIds: [m.chunkId], status: "done" });
  } else {
    await insertExtraction(tx, objectId, m);
  }
  const routeRun = await insertTestExtractionRun(tx, { task: "extract-route" });
  const [route] = await tx.insert(routes).values({ documentVersionId: m.versionId, extractionRunId: routeRun, stopsCount: 1 }).returning({ id: routes.id });
  const [stop] = await tx
    .insert(routeStops)
    .values({ routeId: route!.id, ordinal: 0, name: "Kolona", geoObjectId: objectId, mentionId: m.mentionId, mooring: "anchor", quote: "We moored at Kolona", quoteVerified: true, quoteChunkId: m.chunkId })
    .returning({ id: routeStops.id });
  return { stopId: stop!.id, documentId: m.documentId, sourceId };
}

/**
 * A fact on a name mention of a page of type `docType` (default `marina`) whose second chunk carries a `bound` mention of
 * the object when `bound` (ruling R4: the version is bound to the place, the fact may sit on a name mention); then the
 * object's place also gets a current bound `place_websites` row whose start URL is the page's URL.
 */
export async function pageFact(
  tx: Db,
  objectId: string,
  o: { bound: boolean; docType?: DocType; attribute?: string; value?: unknown },
): Promise<EvidenceFact> {
  const docType = o.docType ?? "marina";
  const sourceId = await insertSource(tx, docType, 0.7);
  const text = "Kolona: good holding in sand.";
  const v = await insertTestVersion(tx, [text, "Visitor berths are available all year."], { sourceId, docType });
  const [name] = await tx
    .insert(mentions)
    .values({ documentVersionId: v.versionId, chunkId: v.chunkIds[0]!, geoObjectId: objectId, surface: "Kolona", charStart: 0, charEnd: 6, observedAt: "2026-10-19", confidence: 1, matchKind: "deterministic" })
    .returning({ id: mentions.id });
  if (o.bound) {
    await tx
      .insert(mentions)
      .values({ documentVersionId: v.versionId, chunkId: v.chunkIds[1]!, geoObjectId: objectId, surface: "", charStart: 0, charEnd: 0, observedAt: "2026-10-19", confidence: 1, matchKind: "bound" });
    const [doc] = await tx.select({ url: documents.urlNormalized }).from(documents).where(eq(documents.id, v.documentId));
    const [place] = await tx.select({ id: places.id }).from(places).where(and(eq(places.geoObjectId, objectId), isNull(places.validTo)));
    if (place) {
      await tx.insert(placeWebsites).values({ placeId: place.id, geoObjectId: objectId, url: doc!.url, urlNormalized: doc!.url, origin: "osm", sourceId, bound: true });
    }
  }
  const m: TestMention = { versionId: v.versionId, chunkId: v.chunkIds[0]!, mentionId: name!.id, documentId: v.documentId, text };
  const extractionRunId = await insertExtraction(tx, objectId, m);
  const factId = await insertMentionFact(tx, objectId, m, extractionRunId, { attribute: o.attribute ?? "berthable", value: o.value ?? true });
  return { factId, documentId: v.documentId, versionId: v.versionId, sourceId };
}
