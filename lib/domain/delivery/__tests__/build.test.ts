import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Archive } from "@/lib/adapters/s3";
import type { ChangesFile, HighlightsFile, Manifest, SpotsFile } from "@/contract";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { deliveredObjects, deliveries, documents, highlightSelections, places, profileSummaries, textShingles } from "@/lib/db/schema";
import { shingleHashes } from "@/lib/domain/documents/shingles";
import { newId } from "@/lib/domain/ids";
import { insertExtraction, insertMention, insertMentionFact, insertProfile, provenanceEntry } from "@/test/consolidation";
import { startWhileLocked, testDb, withRollback } from "@/test/db";
import { seedDeliverySubdivision, SPOT_A_ATTRIBUTES, SPOT_A_SUMMARY, spotAProvenance, type DeliveryFixture } from "@/test/fixtures/delivery/subdivision";
import { deleteTestObjects, memoryArchive, testArchive } from "@/test/s3";
import { insertTestVersion } from "@/test/text";
import { SubdivisionNotFound } from "../load";
import { buildDelivery, previousPackage } from "../build";
import { sha256Hex } from "../serialize";
import type { SubdivisionScope } from "../types";

/*
 * Package builds (plan Task 9) on the synthetic fixture subdivision (test/fixtures/delivery/subdivision.ts) in `withRollback`.
 * The build date lies in the future: the fixture's geo rows are valid from the database's `current_date`, so a fixed
 * date in the past (the plan's 2026-10-19) would see an empty subdivision once that day has passed.
 */

const NOW = new Date("2040-06-01T08:00:00Z");
const EXPECTED = "../../../../test/fixtures/delivery/expected";
const FILES = ["manifest.json", "spots.json", "highlights.json", "regions.json", "coast.geojson", "weather-points.json"];

const decode = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));
async function readJson<T>(archive: Archive, key: string): Promise<T> {
  const text = decode(await archive.get(key));
  if (text === null) throw new Error(`no object ${key}`);
  return JSON.parse(text) as T;
}
const prefixOf = (f: DeliveryFixture, dataVersion: number) => `deliveries/${f.subdivisionKey}/${dataVersion}/`;

async function deliveryRows(tx: Db, subdivisionId: string) {
  return tx.select().from(deliveries).where(eq(deliveries.subdivisionId, subdivisionId)).orderBy(asc(deliveries.createdAt), asc(deliveries.id));
}
async function objectRows(tx: Db, subdivisionId: string) {
  return tx
    .select()
    .from(deliveredObjects)
    .where(eq(deliveredObjects.subdivisionId, subdivisionId))
    .orderBy(asc(deliveredObjects.publicId), asc(deliveredObjects.profileVersion));
}

/** A second profile version of A with `patch` applied to its attributes, its summary carried over. */
async function changeA(tx: Db, f: DeliveryFixture, patch: Record<string, unknown>): Promise<void> {
  await insertProfile(
    tx,
    f.places.A.geoObjectId,
    { ...SPOT_A_ATTRIBUTES, anchor_position: { lon: 21.1301, lat: 35.1445 }, "place.position": { lon: f.positions.A[0], lat: f.positions.A[1] }, ...patch },
    { ...spotAProvenance(f.factId), "place.position": provenanceEntry("gazetteer", { confidence: 1 }) },
    { version: 2, sourcesCount: 3, documentsCount: 1, confidence: 0.72 },
  );
  await tx.insert(profileSummaries).values({ geoObjectId: f.places.A.geoObjectId, profileVersion: 2, text: SPOT_A_SUMMARY, status: "ok", attempts: 1, model: "test", promptVersion: 1 });
}

/** `n` words no other text has (a uuid salt in letters plus a running suffix). */
function saltedWords(n: number): string[] {
  const salt = newId().replace(/-/g, "").replace(/\d/g, (d) => "ghijklmnop"[Number(d)]!);
  return Array.from({ length: n }, (_, i) => `${salt}${"abcdefghijklmnopqrstuvwxyz"[i % 26]}`);
}

/**
 * A seeded Fisher–Yates shuffle (mulberry32): the same seed gives the same order, and a list of two or more never
 * comes back in its input order (rotated once if the draw kept it).
 */
function seededShuffle(seed: number): <T>(list: T[]) => T[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return <T>(list: T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    if (out.length > 1 && out.every((v, i) => v === list[i])) out.push(out.shift()!);
    return out;
  };
}

/** Two more sources on every spot and POI and one more name on every region, so every inner list has two or more. */
function withExtras(scope: SubdivisionScope): SubdivisionScope {
  const extra = (id: string) =>
    [1, 2].map((n) => ({ url: `https://extra-${n}-${id.toLowerCase()}.test.invalid/page`, docType: "forum" as const, observedAt: `2025-0${n}-01` }));
  return {
    ...scope,
    spots: scope.spots.map((s) => ({ ...s, sources: [...s.sources, ...extra(s.publicId)] })),
    pois: scope.pois.map((p) => ({ ...p, sources: [...p.sources, ...extra(p.publicId)] })),
    regions: scope.regions.map((r) => ({ ...r, names: [...r.names, { lang: "fr", name: `${r.name} (fr)` }] })),
  };
}

/** Every list the loader returns, and every inner list of its objects, in a seeded random order. */
function shuffled(scope: SubdivisionScope): SubdivisionScope {
  const mix = seededShuffle(20400601);
  return {
    ...scope,
    subdivision: { ...scope.subdivision, names: mix(scope.subdivision.names) },
    areas: mix(scope.areas).map((a) => ({ ...a, names: mix(a.names) })),
    tiles: mix(scope.tiles),
    spots: mix(scope.spots).map((s) => ({ ...s, names: mix(s.names), sources: mix(s.sources) })),
    merged: mix(scope.merged),
    pois: mix(scope.pois).map((p) => ({ ...p, sources: mix(p.sources) })),
    regions: mix(scope.regions).map((r) => ({ ...r, names: mix(r.names) })),
    passages: mix(scope.passages),
  };
}

/** A build waiting for the subdivision lock gives up after this (`build.lockTimeoutMs`). */
const shortLock = (ms: number) => ({ ...getConfig().delivery, build: { lockTimeoutMs: ms } });

describe("buildDelivery", () => {
  it("the fixture subdivision builds a valid package equal to the checked-in files", async () => {
    // the one S3 round trip (ruling M6-P18); the keys of the fixed fixture are overwritten by every run
    const archive = testArchive();
    await archive.ensureBucket();
    const keys: string[] = [];
    try {
      await withRollback(async (tx) => {
        const f = await seedDeliverySubdivision(tx, { stable: true });
        keys.push(...FILES.map((file) => `${prefixOf(f, 1)}${file}`));
        const result = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
        expect(result.report.checks.filter((c) => !c.ok)).toEqual([]);
        expect(result).toMatchObject({ status: "valid", dataVersion: 1 });
        for (const file of FILES) {
          const text = decode(await archive.get(`${prefixOf(f, 1)}${file}`));
          expect(text, file).not.toBeNull();
          await expect(text).toMatchFileSnapshot(`${EXPECTED}/${file}`);
        }
      });
    } finally {
      // the rows are rolled back; the files would stay in the test bucket
      await deleteTestObjects(keys);
    }
    for (const key of keys) expect(await archive.exists(key), key).toBe(false);
  });

  it("the first package has data version 1, no changes.json and versions 1", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const result = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, triggeredBy: "test", inCallerTransaction: true });
      expect(result).toMatchObject({ status: "valid", dataVersion: 1 });
      expect(archive.keys()).toEqual(FILES.map((file) => `${prefixOf(f, 1)}${file}`).sort());

      const manifest = await readJson<Manifest>(archive, `${prefixOf(f, 1)}manifest.json`);
      expect(manifest).toMatchObject({ scope: { type: "subdivision", dataVersion: 1, previousDataVersion: null }, generatedAt: NOW.toISOString() });
      expect(manifest.objectCounts).toEqual({ spots: 3, highlights: 1, regions: 2, weatherPoints: 2, coastFeatures: manifest.objectCounts.coastFeatures, changes: 0 });
      // every other file with its hash and size, in contract order
      expect(manifest.files.map((x) => x.name)).toEqual(FILES.slice(1));
      for (const entry of manifest.files) {
        const stored = (await archive.get(`${prefixOf(f, 1)}${entry.name}`))!;
        expect(entry, entry.name).toEqual({ name: entry.name, sha256: sha256Hex(stored), bytes: stored.byteLength });
      }
      // GeoJSON as such, every other file as JSON
      for (const file of FILES) {
        expect(archive.contentType(`${prefixOf(f, 1)}${file}`), file).toBe(file === "coast.geojson" ? "application/geo+json" : "application/json");
      }

      const [row] = await deliveryRows(tx, f.subdivisionId);
      expect(row).toMatchObject({
        id: result.deliveryId,
        status: "valid",
        dataVersion: 1,
        schemaVersion: "3.0",
        storagePrefix: prefixOf(f, 1),
        previousDeliveryId: null,
        triggeredBy: "test",
        objectCounts: manifest.objectCounts,
      });
      expect(row!.generatedAt.toISOString()).toBe(NOW.toISOString());
      expect(Object.keys(row!.fileHashes).sort()).toEqual([...FILES].sort());
      expect(row!.changeXmin).toBe((await tx.execute<{ x: string }>(sql`select pg_snapshot_xmin(${row!.changeSnapshot}::pg_snapshot)::text as x`)).rows[0]!.x);

      const objects = await objectRows(tx, f.subdivisionId);
      const spots = await readJson<SpotsFile>(archive, `${prefixOf(f, 1)}spots.json`);
      expect(objects).toHaveLength(spots.spots.length + 1 + 2);
      for (const o of objects) expect(o).toMatchObject({ profileVersion: 1, removed: false, validFrom: "2040-06-01", firstDeliveryId: result.deliveryId });
      expect(spots.spots.every((s) => s.profileVersion === 1 && s.validFrom === "2040-06-01")).toBe(true);
      expect(objects.find((o) => o.publicId === f.places.A.publicId)).toMatchObject({ objectType: "spot", geoObjectId: f.places.A.geoObjectId });

      const previous = await previousPackage(tx, archive, f.subdivisionId);
      expect(previous!.delivery.id).toBe(result.deliveryId);
      expect([...previous!.spots.keys()]).toEqual(spots.spots.map((s) => s.id));
      expect(previous!.highlights.has(f.poiPublicId)).toBe(true);
      expect(previous!.regions.has(f.islandPublicId)).toBe(true);
    });
  });

  it("a second build without changes is unchanged and writes nothing", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const first = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      const keys = archive.keys();
      const objects = await objectRows(tx, f.subdivisionId);
      const second = await buildDelivery(tx, archive, f.subdivisionId, { now: new Date(NOW.getTime() + 86_400_000), inCallerTransaction: true });
      expect(second).toMatchObject({ status: "unchanged", dataVersion: null });
      // the report checks the package the build would have made: the previous version plus 1
      expect(second.report.ok).toBe(true);
      expect(archive.keys()).toEqual(keys);
      expect(await objectRows(tx, f.subdivisionId)).toEqual(objects);
      const rows = await deliveryRows(tx, f.subdivisionId);
      expect(rows.map((r) => r.status)).toEqual(["valid", "unchanged"]);
      expect(rows[1]).toMatchObject({ id: second.deliveryId, dataVersion: null, storagePrefix: null, fileHashes: {}, previousDeliveryId: first.deliveryId });
    });
  });

  it("shuffled load order gives identical files", async () => {
    const build = (transform?: (s: SubdivisionScope) => SubdivisionScope) =>
      withRollback(async (tx) => {
        const archive = memoryArchive();
        const f = await seedDeliverySubdivision(tx, { stable: true });
        await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, scopeTransform: transform, inCallerTransaction: true });
        return Promise.all(archive.keys().map(async (k) => [k, decode(await archive.get(k))] as const));
      });
    const plain = await build(withExtras);
    const mixed = await build((s) => shuffled(withExtras(s)));
    expect(mixed.map(([k]) => k)).toEqual(plain.map(([k]) => k));
    expect(mixed).toEqual(plain);
    // the extras reached the files, so the shuffled inner lists count
    const spots = plain.find(([k]) => k.endsWith("spots.json"))![1]!;
    expect(spots).toContain("https://extra-2-");
    expect(plain.find(([k]) => k.endsWith("regions.json"))![1]).toContain("(fr)");
  });

  it("a changed shelter value gives data version 2 with one updated change and severity safety", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const first = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      await changeA(tx, f, { "shelter.E": 0.8 });
      const later = new Date("2040-06-02T08:00:00Z");
      const second = await buildDelivery(tx, archive, f.subdivisionId, { now: later, inCallerTransaction: true });
      expect(second).toMatchObject({ status: "valid", dataVersion: 2 });
      expect(second.report.ok).toBe(true);

      const changes = await readJson<ChangesFile>(archive, `${prefixOf(f, 2)}changes.json`);
      expect(changes).toMatchObject({ scope: { type: "subdivision", id: f.subdivisionPublicId, dataVersion: 2 }, previousDataVersion: 1 });
      expect(changes.changes).toEqual([
        {
          objectType: "spot",
          objectId: f.places.A.publicId,
          event: "updated",
          fields: ["shelter.sectors.E"],
          severity: "safety",
          summary: { de: "Geändert: Schutz." },
          profileVersion: 2,
        },
      ]);
      const manifest = await readJson<Manifest>(archive, `${prefixOf(f, 2)}manifest.json`);
      expect(manifest).toMatchObject({ scope: { type: "subdivision", dataVersion: 2, previousDataVersion: 1 } });
      expect(manifest.objectCounts.changes).toBe(1);
      expect(manifest.files.map((x) => x.name)).toContain("changes.json");

      const spots = await readJson<SpotsFile>(archive, `${prefixOf(f, 2)}spots.json`);
      const a = spots.spots.find((s) => s.id === f.places.A.publicId)!;
      expect(a).toMatchObject({ profileVersion: 2, validFrom: "2040-06-02" });
      expect(a.shelter.sectors.E).toBe(0.8);
      // an unchanged spot keeps its version and date
      expect(spots.spots.find((s) => s.id === f.places.M.publicId)).toMatchObject({ profileVersion: 1, validFrom: "2040-06-01" });

      const rows = await deliveryRows(tx, f.subdivisionId);
      expect(rows[1]).toMatchObject({ id: second.deliveryId, previousDeliveryId: first.deliveryId, dataVersion: 2 });
      const added = (await objectRows(tx, f.subdivisionId)).filter((o) => o.firstDeliveryId === second.deliveryId);
      expect(added).toEqual([expect.objectContaining({ publicId: f.places.A.publicId, profileVersion: 2, validFrom: "2040-06-02", removed: false })]);
    });
  });

  it("a merged place keeps its last content with mergedInto and event merged", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      const before = (await readJson<SpotsFile>(archive, `${prefixOf(f, 1)}spots.json`)).spots.find((s) => s.id === f.places.A.publicId)!;
      await tx.update(places).set({ mergedIntoId: f.places.M.placeId }).where(eq(places.id, f.places.A.placeId));

      const second = await buildDelivery(tx, archive, f.subdivisionId, { now: new Date("2040-06-02T08:00:00Z"), inCallerTransaction: true });
      expect(second).toMatchObject({ status: "valid", dataVersion: 2 });
      expect(second.report.ok).toBe(true);
      const after = (await readJson<SpotsFile>(archive, `${prefixOf(f, 2)}spots.json`)).spots.find((s) => s.id === f.places.A.publicId)!;
      expect({ ...after, validFrom: before.validFrom }).toEqual({ ...before, mergedInto: f.places.M.publicId, profileVersion: 2 });
      expect(after.validFrom).toBe("2040-06-02");

      const changes = await readJson<ChangesFile>(archive, `${prefixOf(f, 2)}changes.json`);
      expect(changes.changes.find((c) => c.objectId === f.places.A.publicId)).toMatchObject({
        event: "merged",
        severity: "notable",
        summary: { de: `Zusammengelegt mit ${f.places.M.publicId}.` },
        profileVersion: 2,
      });
      // the highlight no longer counts the merged spot
      expect(changes.changes.find((c) => c.objectId === f.poiPublicId)).toMatchObject({ event: "updated", fields: ["spotIds"] });

      // a third build carries the same content: nothing changed
      expect(await buildDelivery(tx, archive, f.subdivisionId, { now: new Date("2040-06-03T08:00:00Z"), inCallerTransaction: true })).toMatchObject({ status: "unchanged" });
    });
  });

  it("a no longer selected highlight is removed in the change feed and returns with the same hl_ id (spec 16 review focus 4)", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      const first = await readJson<HighlightsFile>(archive, `${prefixOf(f, 1)}highlights.json`);
      const before = first.highlights.find((h) => h.id === f.poiPublicId)!;
      expect(before.spotIds).toEqual([f.places.A.publicId, f.places.M.publicId]);

      // no place selects the taverna any more (a re-selection after a stronger candidate appeared)
      const rows = await tx.select().from(highlightSelections).where(eq(highlightSelections.poiGeoObjectId, f.poiId));
      expect(rows).toHaveLength(2);
      await tx.delete(highlightSelections).where(eq(highlightSelections.poiGeoObjectId, f.poiId));
      const second = await buildDelivery(tx, archive, f.subdivisionId, { now: new Date("2040-06-02T08:00:00Z"), inCallerTransaction: true });
      expect(second).toMatchObject({ status: "valid", dataVersion: 2 });
      expect((await readJson<HighlightsFile>(archive, `${prefixOf(f, 2)}highlights.json`)).highlights).toEqual([]);
      expect((await readJson<ChangesFile>(archive, `${prefixOf(f, 2)}changes.json`)).changes.find((c) => c.objectId === f.poiPublicId)).toMatchObject({
        objectType: "highlight",
        event: "removed",
      });
      // the spots no longer name it
      const spots = await readJson<SpotsFile>(archive, `${prefixOf(f, 2)}spots.json`);
      expect(spots.spots.flatMap((s) => s.highlightIds ?? [])).not.toContain(f.poiPublicId);

      // selected again: the same hl_ id comes back
      await tx.insert(highlightSelections).values(rows);
      const third = await buildDelivery(tx, archive, f.subdivisionId, { now: new Date("2040-06-03T08:00:00Z"), inCallerTransaction: true });
      expect(third).toMatchObject({ status: "valid", dataVersion: 3 });
      const back = (await readJson<HighlightsFile>(archive, `${prefixOf(f, 3)}highlights.json`)).highlights;
      expect(back.map((h) => h.id)).toEqual([f.poiPublicId]);
      expect(back[0]!.spotIds).toEqual(before.spotIds);
      const changes = (await readJson<ChangesFile>(archive, `${prefixOf(f, 3)}changes.json`)).changes;
      expect(changes.find((c) => c.objectId === f.poiPublicId)?.event).not.toBe("removed");
    });
  });

  it("a merged place whose target is not in the package is removed with a warning", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      // B is not delivered (incomplete shelter): A merged into it cannot be carried
      await tx.update(places).set({ mergedIntoId: f.places.B.placeId }).where(eq(places.id, f.places.A.placeId));
      const second = await buildDelivery(tx, archive, f.subdivisionId, { now: new Date("2040-06-02T08:00:00Z"), inCallerTransaction: true });
      expect(second).toMatchObject({ status: "valid", dataVersion: 2 });
      const spots = await readJson<SpotsFile>(archive, `${prefixOf(f, 2)}spots.json`);
      expect(spots.spots.map((s) => s.id)).not.toContain(f.places.A.publicId);
      const changes = await readJson<ChangesFile>(archive, `${prefixOf(f, 2)}changes.json`);
      expect(changes.changes.find((c) => c.objectId === f.places.A.publicId)).toMatchObject({ event: "removed", profileVersion: 2 });
      expect(second.report.warnings).toContainEqual(
        expect.objectContaining({ file: "spots.json", objectId: f.places.A.publicId, message: `Zusammengelegt mit ${f.places.B.publicId}, das nicht geliefert wird: als entfernt gemeldet` }),
      );
      const removed = (await objectRows(tx, f.subdivisionId)).find((o) => o.publicId === f.places.A.publicId && o.removed);
      expect(removed).toMatchObject({ contentHash: "removed", profileVersion: 2, firstDeliveryId: second.deliveryId });
    });
  });

  it("an incomplete-shelter place is not delivered and appears as warning", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const result = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      const spots = await readJson<SpotsFile>(archive, `${prefixOf(f, 1)}spots.json`);
      expect(spots.spots.map((s) => s.id)).toEqual([f.places.A, f.places.M, f.places.C].map((p) => p.publicId).sort());
      expect(result.report.warnings).toContainEqual({
        file: "spots.json",
        objectId: f.places.B.publicId,
        path: null,
        message: "Nicht geliefert: Schutzwerte unvollständig oder ohne Herkunft",
      });
      // the excluded place is delivered with its reason and gets no highlights
      expect(spots.spots.find((s) => s.id === f.places.C.publicId)).toMatchObject({ exclude: { excluded: true, reason: "military" }, highlightIds: [] });
    });
  });

  it("a region fact from a forbidden domain rejects the package under regions.json (final review I-2)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const m = await insertMention(tx, f.islandId, { observedAt: "2026-05-01" });
      const fact = await insertMentionFact(tx, f.islandId, m, await insertExtraction(tx, f.islandId, m), { attribute: "meltemi_exposure", value: 0.7 });
      const navily = "https://www.navily.com/region/nisida";
      await tx.update(documents).set({ url: navily, urlNormalized: navily }).where(eq(documents.id, m.documentId));
      await insertProfile(
        tx,
        f.islandId,
        { meltemi_exposure: 0.7, ferry_traffic: "high", charter_bases: ["X"] },
        {
          meltemi_exposure: provenanceEntry("text", { confidence: 0.6, factIds: [fact] }),
          ferry_traffic: provenanceEntry("text", { confidence: 0.6 }),
          charter_bases: provenanceEntry("text", { confidence: 0.6 }),
        },
        { version: 2, confidence: null },
      );
      const result = await buildDelivery(tx, memoryArchive(), f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(result.status).toBe("rejected");
      expect(result.report.checks.find((c) => c.name === "foreign_content")!.findings).toEqual([
        expect.objectContaining({ file: "regions.json", objectId: f.islandPublicId, message: `Werte aus einer Quelle einer gesperrten Domain (${navily})` }),
      ]);
    });
  });

  it("a restricted zone known only from the island's text is reported as not delivered (final review I-3)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      await insertProfile(
        tx,
        f.islandId,
        { meltemi_exposure: 0.7, ferry_traffic: "high", charter_bases: ["X"], restricted_zones: [{ kind: "military", name: "Kalami" }] },
        {
          meltemi_exposure: provenanceEntry("text", { confidence: 0.6 }),
          ferry_traffic: provenanceEntry("text", { confidence: 0.6 }),
          charter_bases: provenanceEntry("text", { confidence: 0.6 }),
          restricted_zones: provenanceEntry("text", { confidence: 0.6 }),
        },
        { version: 2, confidence: null },
      );
      const result = await buildDelivery(tx, memoryArchive(), f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(result.status).toBe("valid");
      expect(result.report.warnings).toContainEqual({
        file: "regions.json",
        objectId: f.islandPublicId,
        path: null,
        message: "Sperrgebiet laut Text nicht geliefert: Militärisches Sperrgebiet Kalami",
      });
    });
  });

  it("a value whose only forbidden document is gone still rejects the package (final review M-1)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const navily = "https://www.navily.com/port/vathi";
      await tx.update(documents).set({ url: navily, urlNormalized: navily, status: "gone" }).where(eq(documents.id, f.documentId));
      const result = await buildDelivery(tx, memoryArchive(), f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(result.status).toBe("rejected");
      expect(result.report.checks.find((c) => c.name === "foreign_content")!.findings).toEqual([
        expect.objectContaining({ file: "spots.json", objectId: f.places.A.publicId, message: `Werte aus einer Quelle einer gesperrten Domain (${navily})` }),
      ]);
    });
  });

  it("a summary with a copied 16-word passage rejects the package; files lie under rejected/, data version stays", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const words = saltedWords(30);
      const v = await insertTestVersion(tx, [words.join(" ")]);
      await tx.insert(textShingles).values(shingleHashes(words.join(" "), 15).map((shingleHash) => ({ shingleHash, chunkId: v.chunkIds[0]! })));
      const summary = (text: string, promptVersion: number) =>
        tx.insert(profileSummaries).values({ geoObjectId: f.places.A.geoObjectId, profileVersion: 1, text, status: "ok", attempts: 1, model: "test", promptVersion });
      await summary(`Die Bucht: ${words.slice(2, 18).join(" ")}.`, 2);

      const rejected = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(rejected).toMatchObject({ status: "rejected", dataVersion: null });
      expect(rejected.report.ok).toBe(false);
      expect(rejected.report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["verbatim_text"]);
      const prefix = `deliveries/${f.subdivisionKey}/rejected/${rejected.deliveryId}/`;
      expect(archive.keys()).toEqual(FILES.map((file) => `${prefix}${file}`).sort());
      // the stored files carry the version the package would have had
      expect(await readJson<Manifest>(archive, `${prefix}manifest.json`)).toMatchObject({ scope: { type: "subdivision", dataVersion: 1, previousDataVersion: null } });
      const [row] = await deliveryRows(tx, f.subdivisionId);
      expect(row).toMatchObject({ id: rejected.deliveryId, status: "rejected", dataVersion: null, storagePrefix: prefix });
      expect(await objectRows(tx, f.subdivisionId)).toEqual([]);

      // fixed: the next build is the subdivision's first valid package
      await summary(SPOT_A_SUMMARY, 3);
      const valid = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(valid).toMatchObject({ status: "valid", dataVersion: 1 });
      expect((await deliveryRows(tx, f.subdivisionId)).find((r) => r.id === valid.deliveryId)).toMatchObject({ previousDeliveryId: null });
    });
  });

  it("two parallel builds create one data version", async () => {
    // (a) the build takes the per-subdivision lock before it reads anything (ruling M6-P22): held elsewhere, it fails fast
    const subdivisionId = newId();
    await expect(
      startWhileLocked(testDb(), `delivery:${subdivisionId}`, (tx) =>
        buildDelivery(tx, memoryArchive(), subdivisionId, { now: NOW, cfg: shortLock(300), inCallerTransaction: true }),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "55P03" }) });
    // (b) the second of two builds sees the first one's package
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const lockTimeout = async () => (await tx.execute<{ v: string }>(sql`select current_setting('lock_timeout') as v`)).rows[0]!.v;
      const before = await lockTimeout();
      const statuses = [];
      for (let i = 0; i < 2; i++) statuses.push((await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true })).status);
      expect(statuses).toEqual(["valid", "unchanged"]);
      // the build's lock_timeout holds while it waits for the lock only
      expect(await lockTimeout()).toBe(before);
      const objects = await objectRows(tx, f.subdivisionId);
      expect(new Set(objects.map((o) => `${o.publicId}:${o.profileVersion}`)).size).toBe(objects.length);
      expect(new Set(objects.map((o) => o.publicId)).size).toBe(objects.length);
    });
  });

  it("the pool path takes the lock, opens the build snapshot and rejects an unknown subdivision", async () => {
    // committed rows are never written: the subdivision does not exist, so the read fails before any write
    await expect(buildDelivery(testDb(), memoryArchive(), newId(), { now: NOW })).rejects.toBeInstanceOf(SubdivisionNotFound);
  });

  it("a caller's transaction needs the test option, and the option needs a transaction", async () => {
    await withRollback(async (tx) => {
      await expect(buildDelivery(tx, memoryArchive(), newId(), { now: NOW })).rejects.toThrow(/needs the pool handle/);
    });
    await expect(buildDelivery(testDb(), memoryArchive(), newId(), { now: NOW, inCallerTransaction: true })).rejects.toThrow(
      /inCallerTransaction needs a transaction handle/,
    );
  });

  it("on the pool a build waits for the subdivision lock at most build.lockTimeoutMs", async () => {
    const db = testDb();
    const subdivisionId = newId();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`delivery:${subdivisionId}`}))`);
      locked();
      await held;
    });
    await isLocked;
    try {
      const started = Date.now();
      await expect(buildDelivery(db, memoryArchive(), subdivisionId, { now: NOW, cfg: shortLock(200) })).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "55P03" }),
      });
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      release();
      await holder;
    }
  });

  it("a package whose content is unchanged but now fails a check is rejected, not unchanged", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      // A's summary: 16 words of a text that is archived only after the first package
      const words = saltedWords(30);
      await tx.insert(profileSummaries).values({
        geoObjectId: f.places.A.geoObjectId,
        profileVersion: 1,
        text: `Die Bucht: ${words.slice(2, 18).join(" ")}.`,
        status: "ok",
        attempts: 1,
        model: "test",
        promptVersion: 2,
      });
      const first = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(first).toMatchObject({ status: "valid", dataVersion: 1 });

      const v = await insertTestVersion(tx, [words.join(" ")]);
      await tx.insert(textShingles).values(shingleHashes(words.join(" "), 15).map((shingleHash) => ({ shingleHash, chunkId: v.chunkIds[0]! })));
      const second = await buildDelivery(tx, archive, f.subdivisionId, { now: new Date("2040-06-02T08:00:00Z"), inCallerTransaction: true });
      expect(second).toMatchObject({ status: "rejected", dataVersion: null });
      expect(second.report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["verbatim_text"]);
      const prefix = `deliveries/${f.subdivisionKey}/rejected/${second.deliveryId}/`;
      expect(archive.keys().filter((k) => k.startsWith(prefix))).toEqual([...FILES, "changes.json"].map((file) => `${prefix}${file}`).sort());
      expect(await readJson<Manifest>(archive, `${prefix}manifest.json`)).toMatchObject({ scope: { type: "subdivision", dataVersion: 2, previousDataVersion: 1 } });
      expect((await readJson<ChangesFile>(archive, `${prefix}changes.json`)).changes).toEqual([]);
      const rows = await deliveryRows(tx, f.subdivisionId);
      expect(rows.map((r) => r.status)).toEqual(["valid", "rejected"]);
      expect(rows[1]).toMatchObject({ id: second.deliveryId, dataVersion: null, storagePrefix: prefix, previousDeliveryId: first.deliveryId });
      expect((await objectRows(tx, f.subdivisionId)).every((o) => o.firstDeliveryId === first.deliveryId)).toBe(true);
    });
  });

  it("a failed commit leaves no delivery row and a retry reuses the keys", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      await expect(
        buildDelivery(tx, archive, f.subdivisionId, {
          now: NOW,
          inCallerTransaction: true,
          beforeCommit: async () => {
            throw new Error("commit failed");
          },
        }),
      ).rejects.toThrow("commit failed");
      expect(await deliveryRows(tx, f.subdivisionId)).toEqual([]);
      expect(await objectRows(tx, f.subdivisionId)).toEqual([]);
      const keys = archive.keys();
      expect(keys).toEqual(FILES.map((file) => `${prefixOf(f, 1)}${file}`).sort());

      const retry = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(retry).toMatchObject({ status: "valid", dataVersion: 1 });
      expect(archive.keys()).toEqual(keys);
      expect(await deliveryRows(tx, f.subdivisionId)).toHaveLength(1);
    });
  });
});
