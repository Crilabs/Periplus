import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Archive } from "@/lib/adapters/s3";
import type { ChangesFile, Manifest, SpotsFile } from "@/contract";
import type { Db } from "@/lib/db/client";
import { deliveredObjects, deliveries, places, profileSummaries, textShingles } from "@/lib/db/schema";
import { shingleHashes } from "@/lib/domain/documents/shingles";
import { newId } from "@/lib/domain/ids";
import { insertProfile, provenanceEntry } from "@/test/consolidation";
import { startWhileLocked, testDb, withRollback } from "@/test/db";
import { seedDeliveryArea, SPOT_A_ATTRIBUTES, SPOT_A_SUMMARY, spotAProvenance, type DeliveryFixture } from "@/test/fixtures/delivery/area";
import { memoryArchive, testArchive } from "@/test/s3";
import { insertTestVersion } from "@/test/text";
import { AreaNotFound } from "../load";
import { buildDelivery, previousPackage } from "../build";
import type { AreaScope } from "../types";

/*
 * Package builds (plan Task 9) on the synthetic fixture area (test/fixtures/delivery/area.ts) in `withRollback`.
 * The build date lies in the future: the fixture's geo rows are valid from the database's `current_date`, so a fixed
 * date in the past (the plan's 2026-10-19) would see an empty area once that day has passed.
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
const prefixOf = (f: DeliveryFixture, dataVersion: number) => `deliveries/${f.areaPublicId}/${dataVersion}/`;

async function deliveryRows(tx: Db, areaId: string) {
  return tx.select().from(deliveries).where(eq(deliveries.areaId, areaId)).orderBy(asc(deliveries.createdAt), asc(deliveries.id));
}
async function objectRows(tx: Db, areaId: string) {
  return tx
    .select()
    .from(deliveredObjects)
    .where(eq(deliveredObjects.areaId, areaId))
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

/** Reversed lists: the build must not depend on the load order. */
function shuffled(scope: AreaScope): AreaScope {
  const mix = <T>(list: T[]): T[] => [...list].reverse();
  return {
    ...scope,
    area: { ...scope.area, names: mix(scope.area.names) },
    tiles: mix(scope.tiles),
    spots: mix(scope.spots).map((s) => ({ ...s, names: mix(s.names), sources: mix(s.sources) })),
    merged: mix(scope.merged),
    pois: mix(scope.pois),
    regions: mix(scope.regions).map((r) => ({ ...r, names: mix(r.names) })),
    passages: mix(scope.passages),
  };
}

describe("buildDelivery", () => {
  it("the fixture area builds a valid package equal to the checked-in files", async () => {
    // the one S3 round trip (ruling M6-P18); the keys of the fixed fixture are overwritten by every run
    const archive = testArchive();
    await archive.ensureBucket();
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx, { stable: true });
      const result = await buildDelivery(tx, archive, f.areaId, { now: NOW });
      expect(result.report.checks.filter((c) => !c.ok)).toEqual([]);
      expect(result).toMatchObject({ status: "valid", dataVersion: 1 });
      for (const file of FILES) {
        const text = decode(await archive.get(`${prefixOf(f, 1)}${file}`));
        expect(text, file).not.toBeNull();
        await expect(text).toMatchFileSnapshot(`${EXPECTED}/${file}`);
      }
    });
  });

  it("the first package has data version 1, no changes.json and versions 1", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      const result = await buildDelivery(tx, archive, f.areaId, { now: NOW, triggeredBy: "test" });
      expect(result).toMatchObject({ status: "valid", dataVersion: 1 });
      expect(archive.keys()).toEqual(FILES.map((file) => `${prefixOf(f, 1)}${file}`).sort());

      const manifest = await readJson<Manifest>(archive, `${prefixOf(f, 1)}manifest.json`);
      expect(manifest).toMatchObject({ dataVersion: 1, previousDataVersion: null, generatedAt: NOW.toISOString() });
      expect(manifest.objectCounts).toEqual({ spots: 3, highlights: 1, regions: 2, weatherPoints: 2, coastFeatures: manifest.objectCounts.coastFeatures, changes: 0 });
      // every other file with its hash and size, in contract order
      expect(manifest.files.map((x) => x.name)).toEqual(FILES.slice(1));
      const spotsBytes = (await archive.get(`${prefixOf(f, 1)}spots.json`))!;
      expect(manifest.files[0]).toMatchObject({ bytes: spotsBytes.byteLength });

      const [row] = await deliveryRows(tx, f.areaId);
      expect(row).toMatchObject({
        id: result.deliveryId,
        status: "valid",
        dataVersion: 1,
        schemaVersion: "1.0",
        storagePrefix: prefixOf(f, 1),
        previousDeliveryId: null,
        triggeredBy: "test",
        objectCounts: manifest.objectCounts,
      });
      expect(row!.generatedAt.toISOString()).toBe(NOW.toISOString());
      expect(Object.keys(row!.fileHashes).sort()).toEqual([...FILES].sort());
      expect(row!.changeXmin).toBe((await tx.execute<{ x: string }>(sql`select pg_snapshot_xmin(${row!.changeSnapshot}::pg_snapshot)::text as x`)).rows[0]!.x);

      const objects = await objectRows(tx, f.areaId);
      const spots = await readJson<SpotsFile>(archive, `${prefixOf(f, 1)}spots.json`);
      expect(objects).toHaveLength(spots.spots.length + 1 + 2);
      for (const o of objects) expect(o).toMatchObject({ profileVersion: 1, removed: false, validFrom: "2040-06-01", firstDeliveryId: result.deliveryId });
      expect(spots.spots.every((s) => s.profileVersion === 1 && s.validFrom === "2040-06-01")).toBe(true);
      expect(objects.find((o) => o.publicId === f.places.A.publicId)).toMatchObject({ objectType: "spot", geoObjectId: f.places.A.geoObjectId });

      const previous = await previousPackage(tx, archive, f.areaId);
      expect(previous!.delivery.id).toBe(result.deliveryId);
      expect([...previous!.spots.keys()]).toEqual(spots.spots.map((s) => s.id));
      expect(previous!.highlights.has(f.poiPublicId)).toBe(true);
      expect(previous!.regions.has(f.islandPublicId)).toBe(true);
    });
  });

  it("a second build without changes is unchanged and writes nothing", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      const first = await buildDelivery(tx, archive, f.areaId, { now: NOW });
      const keys = archive.keys();
      const objects = await objectRows(tx, f.areaId);
      const second = await buildDelivery(tx, archive, f.areaId, { now: new Date(NOW.getTime() + 86_400_000) });
      expect(second).toMatchObject({ status: "unchanged", dataVersion: null });
      // the report checks the package the build would have made: the previous version plus 1
      expect(second.report.ok).toBe(true);
      expect(archive.keys()).toEqual(keys);
      expect(await objectRows(tx, f.areaId)).toEqual(objects);
      const rows = await deliveryRows(tx, f.areaId);
      expect(rows.map((r) => r.status)).toEqual(["valid", "unchanged"]);
      expect(rows[1]).toMatchObject({ id: second.deliveryId, dataVersion: null, storagePrefix: null, fileHashes: {}, previousDeliveryId: first.deliveryId });
    });
  });

  it("shuffled load order gives identical files", async () => {
    const build = (transform?: (s: AreaScope) => AreaScope) =>
      withRollback(async (tx) => {
        const archive = memoryArchive();
        const f = await seedDeliveryArea(tx, { stable: true });
        await buildDelivery(tx, archive, f.areaId, { now: NOW, scopeTransform: transform });
        return Promise.all(archive.keys().map(async (k) => [k, decode(await archive.get(k))] as const));
      });
    const plain = await build();
    const mixed = await build(shuffled);
    expect(mixed.map(([k]) => k)).toEqual(plain.map(([k]) => k));
    expect(mixed).toEqual(plain);
  });

  it("a changed shelter value gives data version 2 with one updated change and severity safety", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      const first = await buildDelivery(tx, archive, f.areaId, { now: NOW });
      await changeA(tx, f, { "shelter.E": 0.8 });
      const later = new Date("2040-06-02T08:00:00Z");
      const second = await buildDelivery(tx, archive, f.areaId, { now: later });
      expect(second).toMatchObject({ status: "valid", dataVersion: 2 });
      expect(second.report.ok).toBe(true);

      const changes = await readJson<ChangesFile>(archive, `${prefixOf(f, 2)}changes.json`);
      expect(changes).toMatchObject({ dataVersion: 2, previousDataVersion: 1, area: f.areaPublicId });
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
      expect(manifest).toMatchObject({ dataVersion: 2, previousDataVersion: 1 });
      expect(manifest.objectCounts.changes).toBe(1);
      expect(manifest.files.map((x) => x.name)).toContain("changes.json");

      const spots = await readJson<SpotsFile>(archive, `${prefixOf(f, 2)}spots.json`);
      const a = spots.spots.find((s) => s.id === f.places.A.publicId)!;
      expect(a).toMatchObject({ profileVersion: 2, validFrom: "2040-06-02" });
      expect(a.shelter.sectors.E).toBe(0.8);
      // an unchanged spot keeps its version and date
      expect(spots.spots.find((s) => s.id === f.places.M.publicId)).toMatchObject({ profileVersion: 1, validFrom: "2040-06-01" });

      const rows = await deliveryRows(tx, f.areaId);
      expect(rows[1]).toMatchObject({ id: second.deliveryId, previousDeliveryId: first.deliveryId, dataVersion: 2 });
      const added = (await objectRows(tx, f.areaId)).filter((o) => o.firstDeliveryId === second.deliveryId);
      expect(added).toEqual([expect.objectContaining({ publicId: f.places.A.publicId, profileVersion: 2, validFrom: "2040-06-02", removed: false })]);
    });
  });

  it("a merged place keeps its last content with mergedInto and event merged", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      await buildDelivery(tx, archive, f.areaId, { now: NOW });
      const before = (await readJson<SpotsFile>(archive, `${prefixOf(f, 1)}spots.json`)).spots.find((s) => s.id === f.places.A.publicId)!;
      await tx.update(places).set({ mergedIntoId: f.places.M.placeId }).where(eq(places.id, f.places.A.placeId));

      const second = await buildDelivery(tx, archive, f.areaId, { now: new Date("2040-06-02T08:00:00Z") });
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
      expect(await buildDelivery(tx, archive, f.areaId, { now: new Date("2040-06-03T08:00:00Z") })).toMatchObject({ status: "unchanged" });
    });
  });

  it("a merged place whose target is not in the package is removed with a warning", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      await buildDelivery(tx, archive, f.areaId, { now: NOW });
      // B is not delivered (incomplete shelter): A merged into it cannot be carried
      await tx.update(places).set({ mergedIntoId: f.places.B.placeId }).where(eq(places.id, f.places.A.placeId));
      const second = await buildDelivery(tx, archive, f.areaId, { now: new Date("2040-06-02T08:00:00Z") });
      expect(second).toMatchObject({ status: "valid", dataVersion: 2 });
      const spots = await readJson<SpotsFile>(archive, `${prefixOf(f, 2)}spots.json`);
      expect(spots.spots.map((s) => s.id)).not.toContain(f.places.A.publicId);
      const changes = await readJson<ChangesFile>(archive, `${prefixOf(f, 2)}changes.json`);
      expect(changes.changes.find((c) => c.objectId === f.places.A.publicId)).toMatchObject({ event: "removed", profileVersion: 2 });
      expect(second.report.warnings).toContainEqual(
        expect.objectContaining({ file: "spots.json", objectId: f.places.A.publicId, message: `Zusammengelegt mit ${f.places.B.publicId}, das nicht geliefert wird: als entfernt gemeldet` }),
      );
      const removed = (await objectRows(tx, f.areaId)).find((o) => o.publicId === f.places.A.publicId && o.removed);
      expect(removed).toMatchObject({ contentHash: "removed", profileVersion: 2, firstDeliveryId: second.deliveryId });
    });
  });

  it("an incomplete-shelter place is not delivered and appears as warning", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      const result = await buildDelivery(tx, archive, f.areaId, { now: NOW });
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

  it("a summary with a copied 16-word passage rejects the package; files lie under rejected/, data version stays", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      const words = saltedWords(30);
      const v = await insertTestVersion(tx, [words.join(" ")]);
      await tx.insert(textShingles).values(shingleHashes(words.join(" "), 15).map((shingleHash) => ({ shingleHash, chunkId: v.chunkIds[0]! })));
      const summary = (text: string, promptVersion: number) =>
        tx.insert(profileSummaries).values({ geoObjectId: f.places.A.geoObjectId, profileVersion: 1, text, status: "ok", attempts: 1, model: "test", promptVersion });
      await summary(`Die Bucht: ${words.slice(2, 18).join(" ")}.`, 2);

      const rejected = await buildDelivery(tx, archive, f.areaId, { now: NOW });
      expect(rejected).toMatchObject({ status: "rejected", dataVersion: null });
      expect(rejected.report.ok).toBe(false);
      expect(rejected.report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["verbatim_text"]);
      const prefix = `deliveries/${f.areaPublicId}/rejected/${rejected.deliveryId}/`;
      expect(archive.keys()).toEqual(FILES.map((file) => `${prefix}${file}`).sort());
      // the stored files carry the version the package would have had
      expect(await readJson<Manifest>(archive, `${prefix}manifest.json`)).toMatchObject({ dataVersion: 1, previousDataVersion: null });
      const [row] = await deliveryRows(tx, f.areaId);
      expect(row).toMatchObject({ id: rejected.deliveryId, status: "rejected", dataVersion: null, storagePrefix: prefix });
      expect(await objectRows(tx, f.areaId)).toEqual([]);

      // fixed: the next build is the area's first valid package
      await summary(SPOT_A_SUMMARY, 3);
      const valid = await buildDelivery(tx, archive, f.areaId, { now: NOW });
      expect(valid).toMatchObject({ status: "valid", dataVersion: 1 });
      expect((await deliveryRows(tx, f.areaId)).find((r) => r.id === valid.deliveryId)).toMatchObject({ previousDeliveryId: null });
    });
  });

  it("two parallel builds create one data version", async () => {
    // (a) the build takes the per-area lock before it reads anything (ruling M6-P22): held elsewhere, it fails fast
    const areaId = newId();
    await expect(
      startWhileLocked(testDb(), `delivery:${areaId}`, (tx) => buildDelivery(tx, memoryArchive(), areaId, { now: NOW })),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "55P03" }) });
    // (b) the second of two builds sees the first one's package
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      const statuses = [];
      for (let i = 0; i < 2; i++) statuses.push((await buildDelivery(tx, archive, f.areaId, { now: NOW })).status);
      expect(statuses).toEqual(["valid", "unchanged"]);
      const objects = await objectRows(tx, f.areaId);
      expect(new Set(objects.map((o) => `${o.publicId}:${o.profileVersion}`)).size).toBe(objects.length);
      expect(new Set(objects.map((o) => o.publicId)).size).toBe(objects.length);
    });
  });

  it("the pool path takes the lock, opens the build snapshot and rejects an unknown area", async () => {
    // committed rows are never written: the area does not exist, so the read fails before any write
    await expect(buildDelivery(testDb(), memoryArchive(), newId(), { now: NOW })).rejects.toBeInstanceOf(AreaNotFound);
  });

  it("a failed commit leaves no delivery row and a retry reuses the keys", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      await expect(
        buildDelivery(tx, archive, f.areaId, {
          now: NOW,
          beforeCommit: async () => {
            throw new Error("commit failed");
          },
        }),
      ).rejects.toThrow("commit failed");
      expect(await deliveryRows(tx, f.areaId)).toEqual([]);
      expect(await objectRows(tx, f.areaId)).toEqual([]);
      const keys = archive.keys();
      expect(keys).toEqual(FILES.map((file) => `${prefixOf(f, 1)}${file}`).sort());

      const retry = await buildDelivery(tx, archive, f.areaId, { now: NOW });
      expect(retry).toMatchObject({ status: "valid", dataVersion: 1 });
      expect(archive.keys()).toEqual(keys);
      expect(await deliveryRows(tx, f.areaId)).toHaveLength(1);
    });
  });
});
