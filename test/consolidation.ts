import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  computations,
  extractionUnits,
  facts,
  mentions,
  places,
  profiles,
  reviewDecisions,
  reviewTasks,
  sources,
  type ComputationKind,
  type DocType,
  type ExtractionPurpose,
  type PlaceStatus,
} from "@/lib/db/schema";
import type { GeoObjectType } from "@/lib/db/schema/geo";
import type { AttributeProvenance, ProvenanceOrigin } from "@/lib/domain/consolidation/types";
import { newId } from "@/lib/domain/ids";
import { insertNamedObject, insertTestExtractionRun, insertTestRun, insertTestVersion } from "@/test/text";

/*
 * Fixtures for consolidation tests against the database: places, sources, mentions with text facts of an active
 * extraction run, computations and profile review tasks, inserted directly. Meant for `withRollback`; synthetic
 * objects at 21.0° E / 35.2° N (outside the pilot box), sources on `<uuid>.test.invalid`. A test that commits must
 * use other coordinates (see `store.test.ts`): committed places at 21.0° E / 35.2° N join the geometry test tiles.
 */

const extractFacts = loadConfig("config").models.tasks["extract-facts"]!;
/** The active fact schema version: fixtures that mean "the active schema" use it, so a schema switch breaks no test. */
const ACTIVE_SCHEMA = loadConfig("config").factSchema.version;
const QUOTE = "good holding in sand";
const TEXT = `Kolona: ${QUOTE}.`;

/** A geo object (default a bay) with a place (anchorage, default confirmed). */
export async function insertPlace(
  db: Db,
  o: { lon?: number; lat?: number; name?: string; type?: GeoObjectType; status?: PlaceStatus } = {},
): Promise<{ objectId: string; placeId: string }> {
  const lon = o.lon ?? 21.0;
  const lat = o.lat ?? 35.2;
  const objectId = await insertNamedObject(db, { type: o.type ?? "bay", names: [{ name: o.name ?? "Kolona" }], lon, lat });
  const [p] = await db
    .insert(places)
    .values({ geoObjectId: objectId, kind: "anchorage", status: o.status ?? "confirmed", position: geomFromGeoJson({ type: "Point", coordinates: [lon, lat] }) })
    .returning({ id: places.id });
  return { objectId, placeId: p!.id };
}

/** A source of `type` with `weight` (default a pilot guide, 0.9). */
export async function insertSource(db: Db, type: DocType = "pilot_guide", weight = 0.9): Promise<string> {
  const [row] = await db
    .insert(sources)
    .values({ domain: `${newId()}.test.invalid`, name: "Test source", type, weight, crawlRules: { startUrls: [] }, origin: "manual" })
    .returning({ id: sources.id });
  return row!.id;
}

export type TestMention = { versionId: string; chunkId: string; mentionId: string; documentId: string; text: string };

/**
 * A version (new document of `sourceId`, or a new version of `documentId`) whose one chunk mentions the object.
 * `observedAt` dates the mention and the version; `undatedVersion` leaves the version at its fetch date (2026-10-19),
 * so a different `observedAt` of the mention is a stated observation date. `runId`: the run whose match wrote it.
 */
export async function insertMention(
  db: Db,
  objectId: string,
  o: { sourceId?: string; documentId?: string; observedAt?: string; text?: string; undatedVersion?: boolean; runId?: string; docType?: DocType } = {},
): Promise<TestMention> {
  const text = o.text ?? TEXT;
  const v = await insertTestVersion(db, [text], { sourceId: o.sourceId, documentId: o.documentId, observedAt: o.undatedVersion ? undefined : o.observedAt, docType: o.docType });
  const [m] = await db
    .insert(mentions)
    .values({ documentVersionId: v.versionId, chunkId: v.chunkIds[0]!, geoObjectId: objectId, surface: "Kolona", charStart: 0, charEnd: 6, observedAt: o.observedAt ?? "2026-10-19", confidence: 1, matchKind: "deterministic", runId: o.runId ?? null })
    .returning({ id: mentions.id });
  return { versionId: v.versionId, chunkId: v.chunkIds[0]!, mentionId: m!.id, documentId: v.documentId, text };
}

/** An extraction run (default regular, finished: the active one; of run `runId`, else of a new run) with a done unit for (version, object). */
export async function insertExtraction(
  db: Db,
  objectId: string,
  m: TestMention,
  o: { purpose?: ExtractionPurpose; status?: "finished" | "blocked"; startedAt?: Date; model?: string; runId?: string } = {},
): Promise<string> {
  const status = o.status ?? "finished";
  const id = await insertTestExtractionRun(db, {
    runId: o.runId ?? (await insertTestRun(db)),
    model: o.model ?? extractFacts.model,
    promptVersion: extractFacts.promptVersion,
    purpose: o.purpose ?? "regular",
    status,
    blockedReason: status === "blocked" ? "quote_fidelity" : null,
    startedAt: o.startedAt ?? new Date("2026-10-18T10:00:00Z"),
  });
  await db.insert(extractionUnits).values({ extractionRunId: id, documentVersionId: m.versionId, geoObjectId: objectId, part: 0, level: "place", mentionIds: [m.mentionId], chunkIds: [m.chunkId], status: "done" });
  return id;
}

/** A fact with a verified quote on the mention's chunk, of extraction run `extractionRunId` (default holding good). */
export async function insertMentionFact(
  db: Db,
  objectId: string,
  m: TestMention,
  extractionRunId: string,
  o: { attribute?: string; value?: unknown; observedAt?: string; confidence?: number } = {},
): Promise<string> {
  const start = m.text.indexOf(QUOTE);
  const [row] = await db
    .insert(facts)
    .values({
      geoObjectId: objectId,
      attribute: o.attribute ?? "holding",
      value: o.value ?? "good",
      mentionId: m.mentionId,
      quote: QUOTE,
      quoteVerified: true,
      quoteChunkId: m.chunkId,
      quoteStart: start,
      quoteEnd: start + QUOTE.length,
      observedAt: o.observedAt ?? "2026-10-19",
      confidence: o.confidence ?? 0.8,
      extractionRunId,
      factSchemaVersion: ACTIVE_SCHEMA,
    })
    .returning({ id: facts.id });
  return row!.id;
}

/**
 * A text fact of the object: a new document of `sourceId` whose one chunk mentions it, a finished extraction run with
 * a done unit (the active run), and the fact with a verified quote. An `observedAt` other than the version's fetch
 * date (2026-10-19) is a stated observation date (`dateKnown`). `docType` is the version's type (default `trip_report`).
 */
export async function insertTextFact(
  db: Db,
  objectId: string,
  sourceId: string,
  f: { attribute: string; value: unknown; observedAt?: string; confidence?: number; docType?: DocType },
): Promise<string> {
  const observedAt = f.observedAt ?? "2026-10-19";
  const m = await insertMention(db, objectId, { sourceId, observedAt, undatedVersion: true, docType: f.docType });
  return insertMentionFact(db, objectId, m, await insertExtraction(db, objectId, m), { ...f, observedAt });
}

/** A computation of `kind` with one fact per entry of `values` (confidence `confidence`, default 0.55). */
export async function insertComputation(
  db: Db,
  objectId: string,
  kind: ComputationKind,
  values: Record<string, unknown>,
  o: { confidence?: number; createdAt?: Date; outputs?: Record<string, unknown> } = {},
): Promise<{ computationId: string; factIds: string[] }> {
  const createdAt = o.createdAt ?? new Date("2026-10-01T10:00:00Z");
  const [c] = await db
    .insert(computations)
    .values({ geoObjectId: objectId, kind, inputs: values, inputsHash: newId(), outputs: o.outputs ?? {}, rulesVersion: "test", createdAt })
    .returning({ id: computations.id });
  const rows = await db
    .insert(facts)
    .values(
      Object.entries(values).map(([attribute, value]) => ({
        geoObjectId: objectId,
        attribute,
        value,
        computationId: c!.id,
        observedAt: createdAt.toISOString().slice(0, 10),
        confidence: o.confidence ?? 0.55,
        factSchemaVersion: ACTIVE_SCHEMA,
      })),
    )
    .returning({ id: facts.id });
  return { computationId: c!.id, factIds: rows.map((r) => r.id) };
}

/** A `conflict` / `uncertain_change` task on `<objectId>:<attribute>` with `context.key`, decided with `action` if given. */
export async function insertProfileTask(
  db: Db,
  objectId: string,
  o: { kind: "conflict" | "uncertain_change"; attribute: string; key: string; status: "open" | "decided"; action?: string },
): Promise<{ taskId: string; decisionId: string | null }> {
  const [t] = await db
    .insert(reviewTasks)
    .values({ kind: o.kind, subjectType: "profile_attribute", subjectId: `${objectId}:${o.attribute}`, context: { key: o.key }, status: o.status })
    .returning({ id: reviewTasks.id });
  if (!o.action) return { taskId: t!.id, decisionId: null };
  const [d] = await db.insert(reviewDecisions).values({ taskId: t!.id, decision: { action: o.action }, decidedBy: "test" }).returning({ id: reviewDecisions.id });
  return { taskId: t!.id, decisionId: d!.id };
}

/** A provenance entry of `origin` (confidence 0.8, class medium, nothing cited) with `patch` applied. */
export function provenanceEntry(origin: ProvenanceOrigin, patch: Partial<AttributeProvenance> = {}): AttributeProvenance {
  return {
    origin,
    rule: origin === "gazetteer" ? "identity" : origin === "derived" ? "derived" : "default",
    confidence: 0.8,
    confidenceClass: "medium",
    observedAt: null,
    lastConfirmedAt: null,
    factIds: [],
    sourceKeys: [],
    computationIds: [],
    poiIds: [],
    expired: false,
    onlyGoneSources: false,
    conflictKey: null,
    observedMonths: [],
    ...patch,
  };
}

/**
 * A profile version of the object with the M5 columns (`content_hash` arbitrary): version 1 from 2026-10-19 unless
 * `opts` say otherwise; `valid_from` must not precede the object's latest version (trigger, drizzle/0034).
 */
export async function insertProfile(
  db: Db,
  geoObjectId: string,
  attributes: Record<string, unknown>,
  provenance: Record<string, AttributeProvenance>,
  opts: { version?: number; validFrom?: string; sourcesCount?: number; documentsCount?: number; confidence?: number | null } = {},
): Promise<string> {
  const [row] = await db
    .insert(profiles)
    .values({
      geoObjectId,
      version: opts.version ?? 1,
      validFrom: opts.validFrom ?? "2026-10-19",
      attributes,
      provenance,
      sourcesCount: opts.sourcesCount ?? 0,
      documentsCount: opts.documentsCount ?? 0,
      confidence: opts.confidence === undefined ? 0.8 : opts.confidence,
      contentHash: newId(),
      factSchemaVersion: ACTIVE_SCHEMA,
      rulesVersion: "test",
    })
    .returning({ id: profiles.id });
  return row!.id;
}
