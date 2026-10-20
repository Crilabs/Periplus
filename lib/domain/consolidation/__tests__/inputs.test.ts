import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getConsolidationConfig, loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, facts, mentions, sources } from "@/lib/db/schema";
import { loadContext, loadInputs } from "@/lib/domain/consolidation/inputs";
import { newId } from "@/lib/domain/ids";
import { insertComputation, insertExtraction, insertMention, insertMentionFact, insertPlace, insertProfileTask, insertSource, type TestMention } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";
import { insertNamedObject, insertTestTile, insertTestVersion } from "@/test/text";

/*
 * Inputs and context of a geo object's consolidation, inside withRollback (synthetic objects around 21.0° E / 35.2° N,
 * sources on `<uuid>.test.invalid`). Other tests commit geo rows near there, so POI assertions name their own POIs.
 */

const config = loadConfig("config");
const cfg = getConsolidationConfig();
/** The run date is the database's date: test objects are valid from it (set before the tests run). */
const opts = { cfg, schemaVersion: "v2", appConfig: config, today: "" };
beforeAll(async () => {
  const { rows } = await testDb().execute<{ today: string }>(sql`select current_date::text as today`);
  opts.today = rows[0]!.today;
});

const LON = 21.0;
const LAT = 35.2;
/** Degrees of longitude per metre at LAT. */
const LON_PER_M = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));

/** A shelter computation with one `shelter.N` fact (confidence 0.7). */
async function shelterComputation(tx: Db, objectId: string, createdAt: Date, value: number, outputs: Record<string, unknown> = {}) {
  const { computationId, factIds } = await insertComputation(tx, objectId, "shelter", { "shelter.N": value }, { confidence: 0.7, createdAt, outputs });
  return { computationId, factId: factIds[0]! };
}

describe("loadInputs", () => {
  it("facts of a non-active extraction run are ignored", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx);
      const m = await insertMention(tx, objectId, { sourceId: await insertSource(tx) });
      const regular = await insertExtraction(tx, objectId, m, { startedAt: new Date("2026-10-10T10:00:00Z") });
      const reprocess = await insertExtraction(tx, objectId, m, { purpose: "reprocess", startedAt: new Date("2026-10-15T10:00:00Z") });
      const comparison = await insertExtraction(tx, objectId, m, { purpose: "comparison", model: "claude-opus-5-5", startedAt: new Date("2026-10-17T10:00:00Z") });
      const blocked = await insertExtraction(tx, objectId, m, { status: "blocked", startedAt: new Date("2026-10-18T10:00:00Z") });
      await insertMentionFact(tx, objectId, m, regular, { value: "good" });
      const kept = await insertMentionFact(tx, objectId, m, reprocess, { value: "moderate" });
      await insertMentionFact(tx, objectId, m, comparison, { value: "poor" });
      await insertMentionFact(tx, objectId, m, blocked, { value: "poor" });

      const { inputs, ignored } = await loadInputs(tx, objectId, opts);
      expect(inputs.map((i) => [i.factId, i.value, i.origin])).toEqual([[kept, "moderate", "text"]]);
      expect(ignored).toEqual({ inactiveRun: 3, unknownAttribute: 0 });
    }));

  it("two documents of one source share one source key", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx);
      const sourceId = await insertSource(tx, "pilot_guide", 0.9);
      const a = await insertMention(tx, objectId, { sourceId });
      const b = await insertMention(tx, objectId, { sourceId });
      await insertMentionFact(tx, objectId, a, await insertExtraction(tx, objectId, a));
      await insertMentionFact(tx, objectId, b, await insertExtraction(tx, objectId, b));

      const { inputs } = await loadInputs(tx, objectId, opts);
      expect(inputs).toHaveLength(2);
      expect(new Set(inputs.map((i) => i.sourceKey))).toEqual(new Set([`source:${sourceId}`]));
      expect(new Set(inputs.map((i) => i.documentId))).toEqual(new Set([a.documentId, b.documentId]));
      expect(inputs.every((i) => i.sourceWeight === 0.9 && i.sourceType === "trip_report")).toBe(true);
    }));

  it("the source type is the version's classified document type (ruling M5-P24)", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx);
      const m = await insertMention(tx, objectId, { sourceId: await insertSource(tx, "forum", 0.4) });
      await tx.execute(sql`update document_versions set classified_doc_type = 'authority' where id = ${m.versionId}`);
      await insertMentionFact(tx, objectId, m, await insertExtraction(tx, objectId, m));
      const { inputs } = await loadInputs(tx, objectId, opts);
      expect(inputs.map((i) => [i.sourceType, i.sourceWeight])).toEqual([["authority", 0.4]]);
    }));

  it("a computed fact of an older computation is not loaded", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx);
      await shelterComputation(tx, objectId, new Date("2026-09-01T10:00:00Z"), 0.4);
      const newer = await shelterComputation(tx, objectId, new Date("2026-10-01T10:00:00Z"), 0.7);

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
      const { objectId } = await insertPlace(tx);
      const gone = await insertMention(tx, objectId, { sourceId: await insertSource(tx), observedAt: "2025-06-01" });
      const active = await insertMention(tx, objectId, { sourceId: await insertSource(tx), observedAt: "2026-10-19" });
      const unchecked = await insertMention(tx, objectId, { sourceId: await insertSource(tx), observedAt: "2026-10-19" });
      await tx.update(documents).set({ status: "gone", lastCheckedAt: new Date("2026-10-18T10:00:00Z") }).where(eq(documents.id, gone.documentId));
      await tx.update(documents).set({ lastCheckedAt: new Date("2026-10-10T22:30:00Z") }).where(eq(documents.id, active.documentId));
      // fact dates: the gone one from its fetch date (no date known), the active one states its own date
      const goneFact = await insertMentionFact(tx, objectId, gone, await insertExtraction(tx, objectId, gone), { observedAt: "2025-06-01" });
      const activeFact = await insertMentionFact(tx, objectId, active, await insertExtraction(tx, objectId, active), { observedAt: "2026-07-01" });
      const uncheckedFact = await insertMentionFact(tx, objectId, unchecked, await insertExtraction(tx, objectId, unchecked), { observedAt: "2026-10-19" });

      const { inputs } = await loadInputs(tx, objectId, opts);
      const byFact = new Map(inputs.map((i) => [i.factId, i]));
      expect(byFact.get(goneFact)).toMatchObject({ gone: true, observedAt: "2025-06-01", lastConfirmedAt: "2025-06-01", dateKnown: false });
      expect(byFact.get(activeFact)).toMatchObject({ gone: false, observedAt: "2026-07-01", lastConfirmedAt: "2026-10-10", dateKnown: true });
      // never checked: the version's fetch date (ruling M5-P21)
      expect(byFact.get(uncheckedFact)).toMatchObject({ gone: false, lastConfirmedAt: "2026-10-19", dateKnown: false });
    }));

  it("text a later version no longer contains is confirmed last by the newest version that still had it (ruling M5-D-R2)", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx);
      const sourceId = await insertSource(tx);
      const text = "Kolona: good holding in sand.";
      const checked = new Date("2026-10-15T10:00:00Z");

      /** A first version holding `text`, the mention and the fact on its chunk; then `next` later versions. */
      async function document(next: Array<{ fetchedAt: string; carry: boolean }>) {
        const v1 = await insertTestVersion(tx, [text], { sourceId, fetchedAt: new Date("2026-08-01T10:00:00Z") });
        const [m] = await tx
          .insert(mentions)
          .values({ documentVersionId: v1.versionId, chunkId: v1.chunkIds[0]!, geoObjectId: objectId, surface: "Kolona", charStart: 0, charEnd: 6, observedAt: "2026-08-01", confidence: 1, matchKind: "deterministic" })
          .returning({ id: mentions.id });
        const mention: TestMention = { versionId: v1.versionId, chunkId: v1.chunkIds[0]!, mentionId: m!.id, documentId: v1.documentId, text };
        const factId = await insertMentionFact(tx, objectId, mention, await insertExtraction(tx, objectId, mention), { observedAt: "2026-08-01" });
        for (const n of next) {
          await insertTestVersion(tx, [n.carry ? text : "Kolona: the taverna is closed."], {
            sourceId,
            documentId: v1.documentId,
            fetchedAt: new Date(n.fetchedAt),
            carried: n.carry ? { 0: v1.chunkIds[0]! } : {},
          });
        }
        await tx.update(documents).set({ lastCheckedAt: checked }).where(eq(documents.id, v1.documentId));
        return factId;
      }

      const dropped = await document([{ fetchedAt: "2026-09-01T10:00:00Z", carry: false }]);
      const carried = await document([{ fetchedAt: "2026-09-01T10:00:00Z", carry: true }]);
      const carriedThenDropped = await document([
        { fetchedAt: "2026-09-01T10:00:00Z", carry: true },
        { fetchedAt: "2026-10-01T10:00:00Z", carry: false },
      ]);

      const { inputs } = await loadInputs(tx, objectId, opts);
      const confirmed = new Map(inputs.map((i) => [i.factId, i.lastConfirmedAt]));
      // the second version dropped the text: last seen in the first version
      expect(confirmed.get(dropped)).toBe("2026-08-01");
      // carried into the current version: the document's last check confirms it
      expect(confirmed.get(carried)).toBe("2026-10-15");
      // carried once, then dropped: last seen in the second version
      expect(confirmed.get(carriedThenDropped)).toBe("2026-09-01");
      expect(inputs.every((i) => i.observedAt === "2026-08-01" && !i.gone)).toBe(true);
    }));

  it("two facts of a duplicated mention enter as two inputs of one source", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx);
      const sourceId = await insertSource(tx);
      const matcher = await insertMention(tx, objectId, { sourceId });
      // the model found the place again next to the matcher's span (mentions can duplicate)
      const [dup] = await tx
        .insert(mentions)
        .values({ documentVersionId: matcher.versionId, chunkId: matcher.chunkId, geoObjectId: objectId, surface: "olona", charStart: 1, charEnd: 6, observedAt: "2026-10-19", confidence: 0.9, matchKind: "model" })
        .returning({ id: mentions.id });
      const run = await insertExtraction(tx, objectId, matcher);
      const a = await insertMentionFact(tx, objectId, matcher, run);
      const b = await insertMentionFact(tx, objectId, { ...matcher, mentionId: dup!.id }, run);

      const { inputs, ignored } = await loadInputs(tx, objectId, opts);
      expect(inputs.map((i) => [i.factId, i.sourceKey, i.documentId])).toEqual(
        [a, b].sort().map((id) => [id, `source:${sourceId}`, matcher.documentId]),
      );
      expect(ignored).toEqual({ inactiveRun: 0, unknownAttribute: 0 });
    }));

  it("the survivor of a merge loads the facts of the objects merged into it, not their computations", () =>
    withRollback(async (tx) => {
      const { objectId: survivor } = await insertPlace(tx);
      const { objectId: merged } = await insertPlace(tx, { name: "Kolona Bay" });
      const { objectId: mergedEarlier } = await insertPlace(tx, { name: "Ormos Kolona" });
      const own = await insertMention(tx, survivor, { sourceId: await insertSource(tx) });
      const ownFact = await insertMentionFact(tx, survivor, own, await insertExtraction(tx, survivor, own));
      // facts of the merged objects: from their own runs (units are per object), a review fact, a computation
      const m = await insertMention(tx, merged, { sourceId: await insertSource(tx) });
      const mergedFact = await insertMentionFact(tx, merged, m, await insertExtraction(tx, merged, m), { value: "moderate" });
      const e = await insertMention(tx, mergedEarlier, { sourceId: await insertSource(tx) });
      const earlierFact = await insertMentionFact(tx, mergedEarlier, e, await insertExtraction(tx, mergedEarlier, e), { value: "poor" });
      const { decisionId } = await insertProfileTask(tx, merged, { kind: "conflict", attribute: "holding", key: "k", status: "decided", action: "value_a" });
      const [review] = await tx
        .insert(facts)
        .values({ geoObjectId: merged, attribute: "holding", value: "good", reviewDecisionId: decisionId, observedAt: "2026-10-12", confidence: 0.95, factSchemaVersion: "v2" })
        .returning({ id: facts.id });
      await shelterComputation(tx, merged, new Date("2026-10-01T10:00:00Z"), 0.4);
      // mergedEarlier was merged into merged, which was then merged into the survivor
      await tx.execute(sql`update geo_objects set merged_into_id = ${merged}, valid_to = current_date where id = ${mergedEarlier}`);
      await tx.execute(sql`update geo_objects set merged_into_id = ${survivor}, valid_to = current_date where id = ${merged}`);

      const { inputs, ignored } = await loadInputs(tx, survivor, opts);
      expect(inputs.map((i) => i.factId).sort()).toEqual([ownFact, mergedFact, earlierFact, review!.id].sort());
      expect(inputs.some((i) => i.origin === "computed")).toBe(false);
      expect(ignored).toEqual({ inactiveRun: 0, unknownAttribute: 0 });
      // the merged object itself is consolidated only as part of its survivor
      expect(await loadContext(tx, merged, cfg, opts.today)).toBeNull();
      expect(await loadContext(tx, survivor, cfg, opts.today)).toMatchObject({ documentsCount: 3, sourcesCount: 3 });
    }));

  it("facts of a rejected or ended source do not count, a paused source still counts", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx);
      const factOf: Record<string, string> = {};
      const ids: Record<string, string> = {};
      for (const name of ["approved", "paused", "rejected", "ended", "endsLater"]) {
        ids[name] = await insertSource(tx);
        const m = await insertMention(tx, objectId, { sourceId: ids[name] });
        factOf[name] = await insertMentionFact(tx, objectId, m, await insertExtraction(tx, objectId, m));
      }
      await tx.update(sources).set({ status: "approved" }).where(eq(sources.id, ids.approved!));
      await tx.update(sources).set({ status: "paused" }).where(eq(sources.id, ids.paused!));
      await tx.update(sources).set({ status: "rejected" }).where(eq(sources.id, ids.rejected!));
      await tx.execute(sql`update sources set valid_to = ${opts.today}::date where id = ${ids.ended!}`);
      await tx.execute(sql`update sources set valid_to = ${opts.today}::date + 1 where id = ${ids.endsLater!}`);

      const { inputs } = await loadInputs(tx, objectId, opts);
      expect(inputs.map((i) => i.factId).sort()).toEqual([factOf.approved, factOf.paused, factOf.endsLater].sort());
      expect(await loadContext(tx, objectId, cfg, opts.today)).toMatchObject({ documentsCount: 3, sourcesCount: 3 });
    }));

  it("validity is judged on the run date, not the database date", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx);
      const poi = await insertNamedObject(tx, { type: "poi", category: "food", names: [{ name: "Taverna Nea" }], lon: LON + 300 * LON_PER_M, lat: LAT });
      const { rows } = await tx.execute<{ yesterday: string }>(sql`select (${opts.today}::date - 1)::text as yesterday`);
      const yesterday = rows[0]!.yesterday;

      // objects created today were not valid yesterday
      const before = await loadInputs(tx, objectId, { ...opts, today: yesterday });
      expect(before.inputs.some((i) => i.poiId === poi)).toBe(false);
      expect(await loadContext(tx, objectId, cfg, yesterday)).toBeNull();
      expect((await loadInputs(tx, objectId, opts)).inputs.some((i) => i.poiId === poi)).toBe(true);
      expect(await loadContext(tx, objectId, cfg, opts.today)).not.toBeNull();
    }));

  it("the place is judged valid on the run date as the object is: one ending after the run date still counts (DAT-5)", () =>
    withRollback(async (tx) => {
      const { objectId, placeId } = await insertPlace(tx);
      const poi = await insertNamedObject(tx, { type: "poi", category: "food", names: [{ name: "Taverna Avrio" }], lon: LON + 300 * LON_PER_M, lat: LAT });
      // planned end tomorrow: valid on the run date
      await tx.execute(sql`update places set valid_to = ${opts.today}::date + 1 where id = ${placeId}`);
      expect((await loadInputs(tx, objectId, opts)).inputs.some((i) => i.poiId === poi)).toBe(true);
      expect((await loadContext(tx, objectId, cfg, opts.today))?.place?.id).toBe(placeId);
    }));

  it("a review fact enters with weight 1 and its stored confidence", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx);
      const { decisionId } = await insertProfileTask(tx, objectId, { kind: "conflict", attribute: "holding", key: "k", status: "decided", action: "value_b" });
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
      const { objectId } = await insertPlace(tx);
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
      const m = await insertMention(tx, islet, { sourceId: await insertSource(tx) });
      const run = await insertExtraction(tx, islet, m);
      await insertMentionFact(tx, islet, m, run, { attribute: "holding", value: "good" });
      const kept = await insertMentionFact(tx, islet, m, run, { attribute: "meltemi_exposure", value: 0.5 });

      const { inputs, ignored } = await loadInputs(tx, islet, opts);
      expect(inputs.map((i) => i.factId)).toEqual([kept]);
      expect(ignored).toEqual({ inactiveRun: 0, unknownAttribute: 1 });
    }));
});

describe("loadContext", () => {
  it("a rejected place has no context; an islet has level island", () =>
    withRollback(async (tx) => {
      const rejected = await insertPlace(tx, { status: "rejected" });
      expect(await loadContext(tx, rejected.objectId, cfg, opts.today)).toBeNull();

      const merged = await insertPlace(tx);
      await tx.execute(sql`update places set merged_into_id = ${rejected.placeId} where id = ${merged.placeId}`);
      expect(await loadContext(tx, merged.objectId, cfg, opts.today)).toBeNull();

      const settlement = await insertNamedObject(tx, { type: "settlement", names: [{ name: "Chora" }], lon: LON, lat: LAT });
      expect(await loadContext(tx, settlement, cfg, opts.today)).toBeNull();
      expect(await loadContext(tx, newId(), cfg, opts.today)).toBeNull();

      const islet = await insertNamedObject(tx, { type: "islet", names: [{ name: "Nisida" }], lon: LON, lat: LAT });
      expect(await loadContext(tx, islet, cfg, opts.today)).toMatchObject({ level: "island", place: null, identity: { name: "Nisida", parentId: null } });
      await tx.execute(sql`update geo_objects set valid_to = current_date where id = ${islet}`);
      expect(await loadContext(tx, islet, cfg, opts.today)).toBeNull();
    }));

  it("documents and sources count distinct documents with mentions", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx);
      const sourceId = await insertSource(tx);
      const a = await insertMention(tx, objectId, { sourceId });
      await insertMention(tx, objectId, { documentId: a.documentId, sourceId }); // second version of the same document
      // a model mention next to the matcher's in the same chunk (mentions can duplicate): still one document
      await tx.insert(mentions).values({ documentVersionId: a.versionId, chunkId: a.chunkId, geoObjectId: objectId, surface: "olona", charStart: 1, charEnd: 6, observedAt: "2026-10-19", confidence: 0.9, matchKind: "model" });
      await insertMention(tx, objectId, { sourceId });
      await insertMention(tx, (await insertPlace(tx, { name: "Other" })).objectId, { sourceId: await insertSource(tx) });

      expect(await loadContext(tx, objectId, cfg, opts.today)).toMatchObject({ documentsCount: 2, sourcesCount: 1 });
    }));

  it("place, identity, tile cycle, computation gaps and review tasks", () =>
    withRollback(async (tx) => {
      // a tile of the synthetic grid nobody else uses (21.6° E / 35.6° N)
      const tileId = await insertTestTile(tx, "q025:806:502");
      await tx.execute(sql`update tiles set cycle_days = 14 where id = ${tileId}`);
      const { objectId, placeId } = await insertPlace(tx, { lon: 21.61, lat: 35.61 });
      await shelterComputation(tx, objectId, new Date("2026-10-01T10:00:00Z"), 0.5, { gaps: [{ attribute: "depth.min", reason: "no_bathymetry" }] });
      await insertProfileTask(tx, objectId, { kind: "conflict", attribute: "holding", key: "seasonal-key", status: "decided", action: "seasonal" });
      await insertProfileTask(tx, objectId, { kind: "conflict", attribute: "services.water", key: "open-key", status: "decided", action: "leave_open" });
      await insertProfileTask(tx, objectId, { kind: "conflict", attribute: "capacity", key: "picked-key", status: "decided", action: "value_a" });
      await insertProfileTask(tx, objectId, { kind: "uncertain_change", attribute: "services.fuel", key: "discarded-key", status: "decided", action: "discard_change" });
      const open = await insertProfileTask(tx, objectId, { kind: "uncertain_change", attribute: "highlight.food", key: "open-uncertain", status: "open" });
      // another object's task with a similar subject never counts
      await insertProfileTask(tx, (await insertPlace(tx, { name: "Other" })).objectId, { kind: "conflict", attribute: "holding", key: "foreign", status: "decided", action: "seasonal" });

      const ctx = (await loadContext(tx, objectId, cfg, opts.today))!;
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
      // a conflict decided for one value (value_a / value_b) is decided, without a resolution marker
      expect(ctx.decidedConflictKeys).toEqual(new Set(["picked-key"]));
      expect(ctx.openTasks).toEqual(new Map([["uncertain_change:highlight.food", { taskId: open.taskId, key: "open-uncertain" }]]));
    }));

  it("without a tile the cycle is the configured default", () =>
    withRollback(async (tx) => {
      // far outside every grid the tests create
      const objectId = await insertNamedObject(tx, { type: "cape", names: [{ name: "Akra" }], lon: -170.1, lat: -60.1 });
      expect(await loadContext(tx, objectId, cfg, opts.today)).toMatchObject({ level: "cape_strait", tileCycleDays: cfg.expiry.defaultCycleDays, areaId: null });
    }));
});
