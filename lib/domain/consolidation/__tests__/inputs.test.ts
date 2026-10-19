import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConsolidationConfig, loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  computations,
  documents,
  extractionUnits,
  facts,
  mentions,
  places,
  reviewDecisions,
  reviewTasks,
  sources,
  type ExtractionPurpose,
  type PlaceStatus,
} from "@/lib/db/schema";
import type { GeoObjectType } from "@/lib/db/schema/geo";
import { loadContext, loadInputs } from "@/lib/domain/consolidation/inputs";
import { newId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestExtractionRun, insertTestRun, insertTestTile, insertTestVersion } from "@/test/text";

/*
 * Inputs and context of a geo object's consolidation, inside withRollback (synthetic objects around 21.0° E / 35.2° N,
 * sources on `<uuid>.test.invalid`). Other tests commit geo rows near there, so POI assertions name their own POIs.
 */

const config = loadConfig("config");
const taskConfig = config.models.tasks["extract-facts"]!;
const cfg = getConsolidationConfig();
const opts = { cfg, schemaVersion: "v2", appConfig: config };

const LON = 21.0;
const LAT = 35.2;
/** Degrees of longitude per metre at LAT. */
const LON_PER_M = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));

async function placeObject(
  tx: Db,
  o: { lon?: number; lat?: number; type?: GeoObjectType; status?: PlaceStatus; name?: string } = {},
): Promise<{ objectId: string; placeId: string }> {
  const lon = o.lon ?? LON;
  const lat = o.lat ?? LAT;
  const objectId = await insertNamedObject(tx, { type: o.type ?? "bay", names: [{ name: o.name ?? "Kolona" }], lon, lat });
  const [p] = await tx
    .insert(places)
    .values({ geoObjectId: objectId, kind: "anchorage", status: o.status ?? "confirmed", position: geomFromGeoJson({ type: "Point", coordinates: [lon, lat] }) })
    .returning({ id: places.id });
  return { objectId, placeId: p!.id };
}

async function source(tx: Db, type: "pilot_guide" | "forum" = "pilot_guide", weight = 0.9): Promise<string> {
  const [row] = await tx
    .insert(sources)
    .values({ domain: `${newId()}.test.invalid`, name: "Test source", type, weight, crawlRules: { startUrls: [] }, origin: "manual" })
    .returning({ id: sources.id });
  return row!.id;
}

type Mention = { versionId: string; chunkId: string; mentionId: string; documentId: string; text: string };

/** A version (new document of `sourceId`, or a new version of `documentId`) whose one chunk mentions the object. */
async function mention(
  tx: Db,
  objectId: string,
  o: { sourceId?: string; documentId?: string; observedAt?: string; text?: string } = {},
): Promise<Mention> {
  const text = o.text ?? "Kolona: good holding in sand.";
  const v = await insertTestVersion(tx, [text], { sourceId: o.sourceId, documentId: o.documentId, observedAt: o.observedAt });
  const [m] = await tx
    .insert(mentions)
    .values({ documentVersionId: v.versionId, chunkId: v.chunkIds[0]!, geoObjectId: objectId, surface: "Kolona", charStart: 0, charEnd: 6, observedAt: o.observedAt ?? "2026-10-19", confidence: 1, matchKind: "deterministic" })
    .returning({ id: mentions.id });
  return { versionId: v.versionId, chunkId: v.chunkIds[0]!, mentionId: m!.id, documentId: v.documentId, text };
}

/** An extraction run with a done unit for (version, object). */
async function extractionRun(
  tx: Db,
  objectId: string,
  m: Mention,
  o: { purpose?: ExtractionPurpose; status?: "finished" | "blocked"; startedAt?: Date; model?: string } = {},
): Promise<string> {
  const status = o.status ?? "finished";
  const id = await insertTestExtractionRun(tx, {
    runId: await insertTestRun(tx),
    model: o.model ?? taskConfig.model,
    promptVersion: taskConfig.promptVersion,
    purpose: o.purpose ?? "regular",
    status,
    blockedReason: status === "blocked" ? "quote_fidelity" : null,
    startedAt: o.startedAt ?? new Date("2026-10-18T10:00:00Z"),
  });
  await tx.insert(extractionUnits).values({ extractionRunId: id, documentVersionId: m.versionId, geoObjectId: objectId, part: 0, level: "place", mentionIds: [m.mentionId], chunkIds: [m.chunkId], status: "done" });
  return id;
}

async function textFact(
  tx: Db,
  objectId: string,
  m: Mention,
  runId: string,
  o: { attribute?: string; value?: unknown; observedAt?: string; confidence?: number } = {},
): Promise<string> {
  const quote = "good holding in sand";
  const start = m.text.indexOf(quote);
  const [row] = await tx
    .insert(facts)
    .values({
      geoObjectId: objectId,
      attribute: o.attribute ?? "holding",
      value: o.value ?? "good",
      mentionId: m.mentionId,
      quote,
      quoteVerified: true,
      quoteChunkId: m.chunkId,
      quoteStart: start,
      quoteEnd: start + quote.length,
      observedAt: o.observedAt ?? "2026-10-19",
      confidence: o.confidence ?? 0.8,
      extractionRunId: runId,
      factSchemaVersion: "v2",
    })
    .returning({ id: facts.id });
  return row!.id;
}

async function computation(tx: Db, objectId: string, createdAt: Date, value: number, outputs: Record<string, unknown> = {}) {
  const [c] = await tx
    .insert(computations)
    .values({ geoObjectId: objectId, kind: "shelter", inputs: { value }, inputsHash: newId(), outputs, rulesVersion: "test", createdAt })
    .returning({ id: computations.id });
  const [f] = await tx
    .insert(facts)
    .values({ geoObjectId: objectId, attribute: "shelter.N", value, computationId: c!.id, observedAt: createdAt.toISOString().slice(0, 10), confidence: 0.7, factSchemaVersion: "v2" })
    .returning({ id: facts.id });
  return { computationId: c!.id, factId: f!.id };
}

async function reviewTask(
  tx: Db,
  objectId: string,
  o: { kind: "conflict" | "uncertain_change"; attribute: string; key: string; status: "open" | "decided"; action?: string },
): Promise<{ taskId: string; decisionId: string | null }> {
  const [t] = await tx
    .insert(reviewTasks)
    .values({ kind: o.kind, subjectType: "profile_attribute", subjectId: `${objectId}:${o.attribute}`, context: { key: o.key }, status: o.status })
    .returning({ id: reviewTasks.id });
  if (!o.action) return { taskId: t!.id, decisionId: null };
  const [d] = await tx.insert(reviewDecisions).values({ taskId: t!.id, decision: { action: o.action }, decidedBy: "test" }).returning({ id: reviewDecisions.id });
  return { taskId: t!.id, decisionId: d!.id };
}

describe("loadInputs", () => {
  it("facts of a non-active extraction run are ignored", () =>
    withRollback(async (tx) => {
      const { objectId } = await placeObject(tx);
      const m = await mention(tx, objectId, { sourceId: await source(tx) });
      const regular = await extractionRun(tx, objectId, m, { startedAt: new Date("2026-10-10T10:00:00Z") });
      const reprocess = await extractionRun(tx, objectId, m, { purpose: "reprocess", startedAt: new Date("2026-10-15T10:00:00Z") });
      const comparison = await extractionRun(tx, objectId, m, { purpose: "comparison", model: "claude-opus-5-5", startedAt: new Date("2026-10-17T10:00:00Z") });
      const blocked = await extractionRun(tx, objectId, m, { status: "blocked", startedAt: new Date("2026-10-18T10:00:00Z") });
      await textFact(tx, objectId, m, regular, { value: "good" });
      const kept = await textFact(tx, objectId, m, reprocess, { value: "moderate" });
      await textFact(tx, objectId, m, comparison, { value: "poor" });
      await textFact(tx, objectId, m, blocked, { value: "poor" });

      const { inputs, ignored } = await loadInputs(tx, objectId, opts);
      expect(inputs.map((i) => [i.factId, i.value, i.origin])).toEqual([[kept, "moderate", "text"]]);
      expect(ignored).toEqual({ inactiveRun: 3, unknownAttribute: 0 });
    }));

  it("two documents of one source share one source key", () =>
    withRollback(async (tx) => {
      const { objectId } = await placeObject(tx);
      const sourceId = await source(tx, "pilot_guide", 0.9);
      const a = await mention(tx, objectId, { sourceId });
      const b = await mention(tx, objectId, { sourceId });
      await textFact(tx, objectId, a, await extractionRun(tx, objectId, a));
      await textFact(tx, objectId, b, await extractionRun(tx, objectId, b));

      const { inputs } = await loadInputs(tx, objectId, opts);
      expect(inputs).toHaveLength(2);
      expect(new Set(inputs.map((i) => i.sourceKey))).toEqual(new Set([`source:${sourceId}`]));
      expect(new Set(inputs.map((i) => i.documentId))).toEqual(new Set([a.documentId, b.documentId]));
      expect(inputs.every((i) => i.sourceWeight === 0.9 && i.sourceType === "trip_report")).toBe(true);
    }));

  it("the source type is the version's classified document type (ruling M5-P24)", () =>
    withRollback(async (tx) => {
      const { objectId } = await placeObject(tx);
      const m = await mention(tx, objectId, { sourceId: await source(tx, "forum", 0.4) });
      await tx.execute(sql`update document_versions set classified_doc_type = 'authority' where id = ${m.versionId}`);
      await textFact(tx, objectId, m, await extractionRun(tx, objectId, m));
      const { inputs } = await loadInputs(tx, objectId, opts);
      expect(inputs.map((i) => [i.sourceType, i.sourceWeight])).toEqual([["authority", 0.4]]);
    }));

  it("a computed fact of an older computation is not loaded", () =>
    withRollback(async (tx) => {
      const { objectId } = await placeObject(tx);
      await computation(tx, objectId, new Date("2026-09-01T10:00:00Z"), 0.4);
      const newer = await computation(tx, objectId, new Date("2026-10-01T10:00:00Z"), 0.7);

      const { inputs } = await loadInputs(tx, objectId, opts);
      expect(inputs).toEqual([
        {
          factId: newer.factId,
          attribute: "shelter.N",
          value: 0.7,
          origin: "computed",
          confidence: 0.7,
          observedAt: "2026-10-01",
          dateKnown: true,
          sourceKey: "computed:shelter",
          sourceWeight: cfg.weights.computed,
          sourceType: null,
          documentId: null,
          gone: false,
          lastConfirmedAt: "2026-10-01",
          computationId: newer.computationId,
          poiId: null,
        },
      ]);
    }));

  it("a gone document keeps observedAt; its lastConfirmedAt is the observation date, an active one its last check", () =>
    withRollback(async (tx) => {
      const { objectId } = await placeObject(tx);
      const gone = await mention(tx, objectId, { sourceId: await source(tx), observedAt: "2025-06-01" });
      const active = await mention(tx, objectId, { sourceId: await source(tx), observedAt: "2026-10-19" });
      const unchecked = await mention(tx, objectId, { sourceId: await source(tx), observedAt: "2026-10-19" });
      await tx.update(documents).set({ status: "gone", lastCheckedAt: new Date("2026-10-18T10:00:00Z") }).where(eq(documents.id, gone.documentId));
      await tx.update(documents).set({ lastCheckedAt: new Date("2026-10-10T22:30:00Z") }).where(eq(documents.id, active.documentId));
      // fact dates: the gone one from its fetch date (no date known), the active one states its own date
      const goneFact = await textFact(tx, objectId, gone, await extractionRun(tx, objectId, gone), { observedAt: "2025-06-01" });
      const activeFact = await textFact(tx, objectId, active, await extractionRun(tx, objectId, active), { observedAt: "2026-07-01" });
      const uncheckedFact = await textFact(tx, objectId, unchecked, await extractionRun(tx, objectId, unchecked), { observedAt: "2026-10-19" });

      const { inputs } = await loadInputs(tx, objectId, opts);
      const byFact = new Map(inputs.map((i) => [i.factId, i]));
      expect(byFact.get(goneFact)).toMatchObject({ gone: true, observedAt: "2025-06-01", lastConfirmedAt: "2025-06-01", dateKnown: false });
      expect(byFact.get(activeFact)).toMatchObject({ gone: false, observedAt: "2026-07-01", lastConfirmedAt: "2026-10-10", dateKnown: true });
      // never checked: the version's fetch date (ruling M5-P21)
      expect(byFact.get(uncheckedFact)).toMatchObject({ gone: false, lastConfirmedAt: "2026-10-19", dateKnown: false });
    }));

  it("a review fact enters with weight 1 and its stored confidence", () =>
    withRollback(async (tx) => {
      const { objectId } = await placeObject(tx);
      const { decisionId } = await reviewTask(tx, objectId, { kind: "conflict", attribute: "holding", key: "k", status: "decided", action: "value_b" });
      const [f] = await tx
        .insert(facts)
        .values({ geoObjectId: objectId, attribute: "holding", value: "poor", reviewDecisionId: decisionId, observedAt: "2026-10-12", confidence: 0.95, factSchemaVersion: "v2" })
        .returning({ id: facts.id });

      const { inputs } = await loadInputs(tx, objectId, opts);
      expect(inputs).toEqual([
        expect.objectContaining({ factId: f!.id, origin: "review", value: "poor", sourceKey: "review", sourceWeight: 1, confidence: 0.95, observedAt: "2026-10-12", dateKnown: true, lastConfirmedAt: "2026-10-12" }),
      ]);
    }));

  it("a food poi 1.2 km away supports highlight.food, one 2.5 km away does not", () =>
    withRollback(async (tx) => {
      const { objectId } = await placeObject(tx);
      const near = await insertNamedObject(tx, { type: "poi", category: "food", names: [{ name: "Taverna Kostas" }], lon: LON + 1200 * LON_PER_M, lat: LAT });
      const far = await insertNamedObject(tx, { type: "poi", category: "food", names: [{ name: "Taverna Far" }], lon: LON + 2500 * LON_PER_M, lat: LAT });
      const { rows } = await tx.execute<{ today: string }>(sql`select current_date::text as today`);

      const { inputs } = await loadInputs(tx, objectId, opts);
      const own = inputs.filter((i) => i.poiId === near || i.poiId === far);
      expect(own).toEqual([
        {
          factId: null,
          attribute: "highlight.food",
          value: { present: true, names: ["Taverna Kostas"] },
          origin: "computed",
          confidence: cfg.poiConfidence,
          observedAt: rows[0]!.today,
          dateKnown: false,
          sourceKey: "gazetteer:osm",
          sourceWeight: cfg.weights.poi,
          sourceType: null,
          documentId: null,
          gone: false,
          lastConfirmedAt: rows[0]!.today,
          computationId: null,
          poiId: near,
        },
      ]);
    }));

  it("poi support only for places; attributes the level does not know are counted", () =>
    withRollback(async (tx) => {
      const islet = await insertNamedObject(tx, { type: "islet", names: [{ name: "Nisida" }], lon: LON, lat: LAT });
      await insertNamedObject(tx, { type: "poi", category: "beach", names: [{ name: "Ammos" }], lon: LON + 100 * LON_PER_M, lat: LAT });
      const m = await mention(tx, islet, { sourceId: await source(tx) });
      const run = await extractionRun(tx, islet, m);
      await textFact(tx, islet, m, run, { attribute: "holding", value: "good" });
      const kept = await textFact(tx, islet, m, run, { attribute: "meltemi_exposure", value: 0.5 });

      const { inputs, ignored } = await loadInputs(tx, islet, opts);
      expect(inputs.map((i) => i.factId)).toEqual([kept]);
      expect(ignored).toEqual({ inactiveRun: 0, unknownAttribute: 1 });
    }));
});

describe("loadContext", () => {
  it("a rejected place has no context; an islet has level island", () =>
    withRollback(async (tx) => {
      const rejected = await placeObject(tx, { status: "rejected" });
      expect(await loadContext(tx, rejected.objectId, cfg)).toBeNull();

      const merged = await placeObject(tx);
      await tx.execute(sql`update places set merged_into_id = ${rejected.placeId} where id = ${merged.placeId}`);
      expect(await loadContext(tx, merged.objectId, cfg)).toBeNull();

      const settlement = await insertNamedObject(tx, { type: "settlement", names: [{ name: "Chora" }], lon: LON, lat: LAT });
      expect(await loadContext(tx, settlement, cfg)).toBeNull();
      expect(await loadContext(tx, newId(), cfg)).toBeNull();

      const islet = await insertNamedObject(tx, { type: "islet", names: [{ name: "Nisida" }], lon: LON, lat: LAT });
      expect(await loadContext(tx, islet, cfg)).toMatchObject({ level: "island", place: null, identity: { name: "Nisida", parentId: null } });
      await tx.execute(sql`update geo_objects set valid_to = current_date where id = ${islet}`);
      expect(await loadContext(tx, islet, cfg)).toBeNull();
    }));

  it("documents and sources count distinct documents with mentions", () =>
    withRollback(async (tx) => {
      const { objectId } = await placeObject(tx);
      const sourceId = await source(tx);
      const a = await mention(tx, objectId, { sourceId });
      await mention(tx, objectId, { documentId: a.documentId, sourceId }); // second version of the same document
      // a model mention next to the matcher's in the same chunk (mentions can duplicate): still one document
      await tx.insert(mentions).values({ documentVersionId: a.versionId, chunkId: a.chunkId, geoObjectId: objectId, surface: "olona", charStart: 1, charEnd: 6, observedAt: "2026-10-19", confidence: 0.9, matchKind: "model" });
      await mention(tx, objectId, { sourceId });
      await mention(tx, (await placeObject(tx, { name: "Other" })).objectId, { sourceId: await source(tx) });

      expect(await loadContext(tx, objectId, cfg)).toMatchObject({ documentsCount: 2, sourcesCount: 1 });
    }));

  it("place, identity, tile cycle, computation gaps and review tasks", () =>
    withRollback(async (tx) => {
      // a tile of the synthetic grid nobody else uses (21.6° E / 35.6° N)
      const tileId = await insertTestTile(tx, "q025:806:502");
      await tx.execute(sql`update tiles set cycle_days = 14 where id = ${tileId}`);
      const { objectId, placeId } = await placeObject(tx, { lon: 21.61, lat: 35.61 });
      await computation(tx, objectId, new Date("2026-10-01T10:00:00Z"), 0.5, { gaps: [{ attribute: "depth.min", reason: "no_bathymetry" }] });
      await reviewTask(tx, objectId, { kind: "conflict", attribute: "holding", key: "seasonal-key", status: "decided", action: "seasonal" });
      await reviewTask(tx, objectId, { kind: "conflict", attribute: "services.water", key: "open-key", status: "decided", action: "leave_open" });
      await reviewTask(tx, objectId, { kind: "conflict", attribute: "capacity", key: "picked-key", status: "decided", action: "value_a" });
      await reviewTask(tx, objectId, { kind: "uncertain_change", attribute: "services.fuel", key: "discarded-key", status: "decided", action: "discard_change" });
      const open = await reviewTask(tx, objectId, { kind: "uncertain_change", attribute: "highlight.food", key: "open-uncertain", status: "open" });
      // another object's task with a similar subject never counts
      await reviewTask(tx, (await placeObject(tx, { name: "Other" })).objectId, { kind: "conflict", attribute: "holding", key: "foreign", status: "decided", action: "seasonal" });

      const ctx = (await loadContext(tx, objectId, cfg))!;
      const { rows } = await tx.execute<{ h: string }>(
        sql`select md5(ST_AsEWKB(ST_SnapToGrid(geom, 1e-6))) as h from geo_objects where id = ${objectId}`,
      );
      expect(ctx).toMatchObject({
        level: "place",
        place: { id: placeId, kind: "anchorage", status: "confirmed", statusReason: null, position: { lon: 21.61, lat: 35.61 }, publicId: null },
        identity: { name: "Kolona", parentId: null, geometryHash: rows[0]!.h },
        tileCycleDays: 14,
        areaId: null,
        computationGaps: { "depth.min": "no_bathymetry" },
      });
      expect(ctx.resolutions).toEqual(new Map([["seasonal-key", "seasonal"], ["open-key", "left_open"]]));
      expect(ctx.decidedUncertainKeys).toEqual(new Set(["discarded-key"]));
      expect(ctx.openTasks).toEqual(new Map([["uncertain_change:highlight.food", { taskId: open.taskId, key: "open-uncertain" }]]));
    }));

  it("without a tile the cycle is the configured default", () =>
    withRollback(async (tx) => {
      // far outside every grid the tests create
      const objectId = await insertNamedObject(tx, { type: "cape", names: [{ name: "Akra" }], lon: -170.1, lat: -60.1 });
      expect(await loadContext(tx, objectId, cfg)).toMatchObject({ level: "cape_strait", tileCycleDays: cfg.expiry.defaultCycleDays, areaId: null });
    }));
});
