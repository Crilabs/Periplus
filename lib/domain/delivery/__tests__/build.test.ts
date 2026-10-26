import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Archive } from "@/lib/adapters/s3";
import type { Manifest, SpotsFile } from "@/contract";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { berthStates, deliveredObjects, deliveries, places, textShingles } from "@/lib/db/schema";
import type { BerthStateFact } from "@/lib/db/schema/research-state";
import { shingleHashes } from "@/lib/domain/documents/shingles";
import { newId } from "@/lib/domain/ids";
import { startWhileLocked, testDb, withRollback } from "@/test/db";
import { seedDeliverySubdivision, type DeliveryFixture } from "@/test/fixtures/delivery/subdivision";
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
const FILES = ["manifest.json", "spots.json", "regions.json", "coast.geojson", "weather-points.json"];

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

/** The berth state of A rewritten (as the research does): `patch` of its core values and/or its facts, `updatedAt` as given. */
async function rewriteStateA(tx: Db, f: DeliveryFixture, o: { core?: Record<string, unknown>; facts?: BerthStateFact[]; updatedAt: Date }): Promise<void> {
  const [row] = await tx.select().from(berthStates).where(eq(berthStates.placeId, f.places.A.placeId));
  const core = { ...row!.core };
  for (const [key, value] of Object.entries(o.core ?? {})) core[key] = { ...core[key]!, value };
  await tx.update(berthStates).set({ core, facts: o.facts ?? row!.facts, updatedAt: o.updatedAt }).where(eq(berthStates.placeId, f.places.A.placeId));
}

/** The facts of A's state with the statement of the landside fact replaced. */
async function factsOfA(tx: Db, f: DeliveryFixture, statement: string): Promise<BerthStateFact[]> {
  const [row] = await tx.select().from(berthStates).where(eq(berthStates.placeId, f.places.A.placeId));
  return row!.facts.map((x) => (x.subject === "landside" ? { ...x, statement } : x));
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

/** One more name on every region and a second landside fact and thing on land on A's state, so every inner list has two or more. */
function withExtras(scope: SubdivisionScope): SubdivisionScope {
  return {
    ...scope,
    spots: scope.spots.map((s) =>
      s.state && s.state.facts.length > 0
        ? {
            ...s,
            state: {
              ...s.state,
              facts: [
                ...s.state.facts,
                { ...s.state.facts[0]!, factId: "0199f0a0-0000-7000-8000-00000000e001", statement: "Another note about the anchorage.", observedAt: "2025-07-01", mentions: 1 },
                { ...s.state.facts[0]!, factId: "0199f0a0-0000-7000-8000-00000000e002", statement: "A third note about the anchorage.", observedAt: "2025-07-01", mentions: 1 },
              ],
            },
          }
        : s,
    ),
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
    spots: mix(scope.spots).map((s) => ({
      ...s,
      names: mix(s.names),
      nearbyObjects: mix(s.nearbyObjects),
      state: s.state && { ...s.state, facts: mix(s.state.facts), nearby: mix(s.state.nearby), gaps: mix(s.state.gaps) },
    })),
    merged: mix(scope.merged),
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

  it("the first package has data version 1, no change feed and no version fields", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const result = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, triggeredBy: "test", inCallerTransaction: true });
      expect(result).toMatchObject({ status: "valid", dataVersion: 1 });
      expect(archive.keys()).toEqual(FILES.map((file) => `${prefixOf(f, 1)}${file}`).sort());

      const manifest = await readJson<Manifest>(archive, `${prefixOf(f, 1)}manifest.json`);
      expect(manifest).toMatchObject({ schemaVersion: "4.0", scope: { type: "subdivision", dataVersion: 1, previousDataVersion: null }, generatedAt: NOW.toISOString() });
      expect(manifest.objectCounts).toEqual({ spots: 3, regions: 2, weatherPoints: 2, coastFeatures: manifest.objectCounts.coastFeatures });
      // the tile date is the newest berth state of the tile's spots (A 2026-10-20 in the west, M 2026-10-19 in the east)
      expect(manifest.tiles.map((t) => t.statesAsOf)).toEqual(expect.arrayContaining(["2026-10-20", "2026-10-19"]));
      expect(manifest.tiles.every((t) => !("profilesAsOf" in t))).toBe(true);
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
        schemaVersion: "4.0",
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
      expect(objects).toHaveLength(spots.spots.length + 2);
      for (const o of objects) expect(o).toMatchObject({ profileVersion: 1, removed: false, validFrom: "2040-06-01", firstDeliveryId: result.deliveryId });
      expect(objects.find((o) => o.publicId === f.places.A.publicId)).toMatchObject({ objectType: "spot", geoObjectId: f.places.A.geoObjectId });
      // the objects carry no version fields; a spot carries the date of its berth state
      for (const s of spots.spots) {
        expect(s).not.toHaveProperty("profileVersion");
        expect(s).not.toHaveProperty("validFrom");
      }
      expect(spots.spots.map((s) => [s.id, s.asOf])).toEqual(
        expect.arrayContaining([
          [f.places.A.publicId, "2026-10-20"],
          [f.places.M.publicId, "2026-10-19"],
          [f.places.C.publicId, null],
        ]),
      );

      const previous = await previousPackage(tx, archive, f.subdivisionId);
      expect(previous!.delivery.id).toBe(result.deliveryId);
      expect([...previous!.spots.keys()]).toEqual(spots.spots.map((s) => s.id));
      expect(previous!.regions.has(f.islandPublicId)).toBe(true);
    });
  });

  it("no source, link, domain, summary or highlight anywhere in the package files (review focus)", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      expect(await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true })).toMatchObject({ status: "valid" });
      for (const file of FILES.filter((x) => x !== "manifest.json" && x !== "coast.geojson")) {
        const text = decode(await archive.get(`${prefixOf(f, 1)}${file}`))!;
        expect(text, file).not.toMatch(/https?:\/\/|www\./i);
        expect(text, file).not.toMatch(/"(sources|summary|highlightIds|highlightLevels|profileVersion|validFrom|url)"/);
      }
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

  it("a stored package of an older contract version with identical content gets a new package of this version", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const first = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(first).toMatchObject({ status: "valid", dataVersion: 1 });
      // the package as a 3.0 deployment stored it: older contract version (its files are never read as the base of this one)
      await tx.execute(sql`alter table deliveries disable trigger deliveries_append_only`);
      await tx.update(deliveries).set({ schemaVersion: "3.0" }).where(eq(deliveries.id, first.deliveryId));
      await tx.execute(sql`alter table deliveries enable trigger deliveries_append_only`);
      const second = await buildDelivery(tx, archive, f.subdivisionId, { now: new Date(NOW.getTime() + 86_400_000), inCallerTransaction: true });
      expect(second).toMatchObject({ status: "valid", dataVersion: 2 });
      const rows = await deliveryRows(tx, f.subdivisionId);
      expect(rows.map((r) => [r.status, r.schemaVersion])).toEqual([
        ["valid", "3.0"],
        ["valid", "4.0"],
      ]);
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
    expect(plain.find(([k]) => k.endsWith("spots.json"))![1]).toContain("A third note about the anchorage.");
    expect(plain.find(([k]) => k.endsWith("regions.json"))![1]).toContain("(fr)");
  });

  it("a changed shelter value in the state gives data version 2 and a new asOf for that spot only", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const first = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      await rewriteStateA(tx, f, { core: { "shelter.E": 0.8 }, updatedAt: new Date("2026-10-23T08:00:00Z") });
      const later = new Date("2040-06-02T08:00:00Z");
      const second = await buildDelivery(tx, archive, f.subdivisionId, { now: later, inCallerTransaction: true });
      expect(second).toMatchObject({ status: "valid", dataVersion: 2 });
      expect(second.report.ok).toBe(true);
      // no change feed in 4.0
      expect(archive.keys().filter((k) => k.startsWith(prefixOf(f, 2))).sort()).toEqual(FILES.map((file) => `${prefixOf(f, 2)}${file}`).sort());
      const manifest = await readJson<Manifest>(archive, `${prefixOf(f, 2)}manifest.json`);
      expect(manifest).toMatchObject({ scope: { type: "subdivision", dataVersion: 2, previousDataVersion: 1 } });
      expect(manifest.files.map((x) => x.name)).not.toContain("changes.json");

      const spots = await readJson<SpotsFile>(archive, `${prefixOf(f, 2)}spots.json`);
      const a = spots.spots.find((s) => s.id === f.places.A.publicId)!;
      expect(a.shelter.sectors.E).toBe(0.8);
      expect(a.asOf).toBe("2026-10-23");
      expect(spots.spots.find((s) => s.id === f.places.M.publicId)!.asOf).toBe("2026-10-19");

      const rows = await deliveryRows(tx, f.subdivisionId);
      expect(rows[1]).toMatchObject({ id: second.deliveryId, previousDeliveryId: first.deliveryId, dataVersion: 2 });
      // only the changed spot got a new object version
      const added = (await objectRows(tx, f.subdivisionId)).filter((o) => o.firstDeliveryId === second.deliveryId);
      expect(added).toEqual([expect.objectContaining({ publicId: f.places.A.publicId, profileVersion: 2, validFrom: "2040-06-02", removed: false })]);
    });
  });

  it("a state rewritten with the same content keeps the package unchanged", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      await rewriteStateA(tx, f, { updatedAt: new Date("2026-10-23T08:00:00Z") });
      expect(await buildDelivery(tx, archive, f.subdivisionId, { now: new Date("2040-06-02T08:00:00Z"), inCallerTransaction: true })).toMatchObject({ status: "unchanged" });
    });
  });

  it("a merged place keeps its last content with mergedInto", async () => {
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
      // the merged spot keeps its last body and its date, carries no images and names its target
      expect(after).toEqual({ ...before, mergedInto: f.places.M.publicId });
      expect(Object.keys(after)).toEqual(Object.keys(before));

      // a third build carries the same content: nothing changed
      expect(await buildDelivery(tx, archive, f.subdivisionId, { now: new Date("2040-06-03T08:00:00Z"), inCallerTransaction: true })).toMatchObject({ status: "unchanged" });
    });
  });

  it("a place taken back from confirmed is missing in the next package and removed in the object versions (review focus 3)", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect((await readJson<SpotsFile>(archive, `${prefixOf(f, 1)}spots.json`)).spots.map((s) => s.id)).toContain(f.places.M.publicId);

      await tx.update(places).set({ status: "rejected" }).where(eq(places.id, f.places.M.placeId));
      const second = await buildDelivery(tx, archive, f.subdivisionId, { now: new Date("2040-06-02T08:00:00Z"), inCallerTransaction: true });
      expect(second).toMatchObject({ status: "valid", dataVersion: 2 });
      expect((await readJson<SpotsFile>(archive, `${prefixOf(f, 2)}spots.json`)).spots.map((s) => s.id)).not.toContain(f.places.M.publicId);
      const removed = (await objectRows(tx, f.subdivisionId)).find((o) => o.publicId === f.places.M.publicId && o.removed);
      expect(removed).toMatchObject({ contentHash: "removed", profileVersion: 2, firstDeliveryId: second.deliveryId });
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
      expect(second.report.warnings).toContainEqual(
        expect.objectContaining({ file: "spots.json", objectId: f.places.A.publicId, message: `Zusammengelegt mit ${f.places.B.publicId}, das nicht geliefert wird: als entfernt gemeldet` }),
      );
      const removed = (await objectRows(tx, f.subdivisionId)).find((o) => o.publicId === f.places.A.publicId && o.removed);
      expect(removed).toMatchObject({ contentHash: "removed", profileVersion: 2, firstDeliveryId: second.deliveryId });
    });
  });

  it("a place without a complete state is not delivered and appears as warning; an excluded one is delivered without a state", async () => {
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
        message: "Nicht geliefert: Schutz oder Ankerposition fehlt im Stand",
      });
      // the excluded place is delivered with its reason, no state date and no free parts
      expect(spots.spots.find((s) => s.id === f.places.C.publicId)).toMatchObject({ exclude: { excluded: true, reason: "military" }, asOf: null, facts: [], nearby: [] });
    });
  });

  it("a fact with a link or a domain name is dropped with a warning, the package stays valid (review focus 5, F3)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      await rewriteStateA(tx, f, { facts: await factsOfA(tx, f, "Details at sailing-guide.example.com and www.example.org."), updatedAt: new Date("2026-10-20T08:00:00Z") });
      const archive = memoryArchive();
      const result = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(result).toMatchObject({ status: "valid", dataVersion: 1 });
      expect(result.report.ok).toBe(true);
      const a = (await readJson<SpotsFile>(archive, `${prefixOf(f, 1)}spots.json`)).spots.find((s) => s.id === f.places.A.publicId)!;
      expect(a.facts.map((x) => x.text)).toEqual(["Strong gusts come down the valley in the afternoon."]);
      expect(result.report.warnings).toContainEqual(expect.objectContaining({ file: "spots.json", objectId: f.places.A.publicId, message: expect.stringContaining("Fakt mit wörtlich kopiertem Text oder fremdem Inhalt") }));
    });
  });

  it("a domain in a spot name still rejects the package under foreign_content (F3)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const result = await buildDelivery(tx, memoryArchive(), f.subdivisionId, {
        now: NOW,
        inCallerTransaction: true,
        scopeTransform: (scope) => ({ ...scope, spots: scope.spots.map((s) => (s.publicId === f.places.A.publicId ? { ...s, name: "Vathi Bay sailing-guide.example.com" } : s)) }),
      });
      expect(result.status).toBe("rejected");
      expect(result.report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["foreign_content"]);
    });
  });

  it("a copied 16-word fact is dropped with a warning; a copied safety fact warns safety_fact_dropped (review focus 1, F3)", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const words = saltedWords(30);
      const v = await insertTestVersion(tx, [words.join(" ")]);
      await tx.insert(textShingles).values(shingleHashes(words.join(" "), 15).map((shingleHash) => ({ shingleHash, chunkId: v.chunkIds[0]! })));
      const copied = `Die Bucht: ${words.slice(2, 18).join(" ")}.`;
      await rewriteStateA(tx, f, { facts: await factsOfA(tx, f, copied), updatedAt: new Date("2026-10-20T08:00:00Z") });

      const first = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(first).toMatchObject({ status: "valid", dataVersion: 1 });
      expect(first.report.ok).toBe(true);
      const a1 = (await readJson<SpotsFile>(archive, `${prefixOf(f, 1)}spots.json`)).spots.find((s) => s.id === f.places.A.publicId)!;
      expect(a1.facts.map((x) => x.text)).toEqual(["Strong gusts come down the valley in the afternoon."]);
      const dropped = first.report.warnings.filter((w) => w.message.startsWith("Fakt mit wörtlich kopiertem Text"));
      expect(dropped).toEqual([expect.objectContaining({ file: "spots.json", objectId: f.places.A.publicId })]);
      expect(first.report.warnings.some((w) => w.message.startsWith("Sicherheitsfakt mit"))).toBe(false);

      // the safety fact copied: the loud warning
      const [row] = await tx.select().from(berthStates).where(eq(berthStates.placeId, f.places.A.placeId));
      const facts = row!.facts.map((x) => (x.safety ? { ...x, statement: copied } : x));
      await rewriteStateA(tx, f, { facts, updatedAt: new Date("2026-10-21T08:00:00Z") });
      const second = await buildDelivery(tx, archive, f.subdivisionId, { now: new Date("2040-06-02T08:00:00Z"), inCallerTransaction: true });
      expect(second.status).toBe("valid");
      const a2 = (await readJson<SpotsFile>(archive, `${prefixOf(f, 2)}spots.json`)).spots.find((s) => s.id === f.places.A.publicId)!;
      expect(a2.facts.some((x) => x.safety)).toBe(false);
      expect(second.report.warnings.filter((w) => w.message.startsWith("Sicherheitsfakt mit"))).toEqual([expect.objectContaining({ objectId: f.places.A.publicId })]);
    });
  });

  it("a rejected package lies under rejected/, the data version stays; the next valid build is the first (F3: a name decides)", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const named = (scope: SubdivisionScope): SubdivisionScope => ({
        ...scope,
        spots: scope.spots.map((s) => (s.publicId === f.places.A.publicId ? { ...s, name: "Vathi Bay sailing-guide.example.com" } : s)),
      });
      const rejected = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true, scopeTransform: named });
      expect(rejected).toMatchObject({ status: "rejected", dataVersion: null });
      expect(rejected.report.ok).toBe(false);
      const prefix = `deliveries/${f.subdivisionKey}/rejected/${rejected.deliveryId}/`;
      expect(archive.keys()).toEqual(FILES.map((file) => `${prefix}${file}`).sort());
      // the stored files carry the version the package would have had
      expect(await readJson<Manifest>(archive, `${prefix}manifest.json`)).toMatchObject({ scope: { type: "subdivision", dataVersion: 1, previousDataVersion: null } });
      const [row] = await deliveryRows(tx, f.subdivisionId);
      expect(row).toMatchObject({ id: rejected.deliveryId, status: "rejected", dataVersion: null, storagePrefix: prefix });
      expect(await objectRows(tx, f.subdivisionId)).toEqual([]);

      // fixed: the next build is the subdivision's first valid package
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
      const first = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(first).toMatchObject({ status: "valid", dataVersion: 1 });

      // a name with a domain (a name is no droppable item, F3): the content is unchanged, the check fails
      const second = await buildDelivery(tx, archive, f.subdivisionId, {
        now: new Date("2040-06-02T08:00:00Z"),
        inCallerTransaction: true,
        scopeTransform: (scope) => ({ ...scope, spots: scope.spots.map((s) => (s.publicId === f.places.A.publicId ? { ...s, names: [...s.names, { lang: "en", name: "sailing-guide.example.com", script: "latin" }] } : s)) }),
      });
      expect(second).toMatchObject({ status: "rejected", dataVersion: null });
      expect(second.report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["foreign_content"]);
      const prefix = `deliveries/${f.subdivisionKey}/rejected/${second.deliveryId}/`;
      expect(archive.keys().filter((k) => k.startsWith(prefix))).toEqual(FILES.map((file) => `${prefix}${file}`).sort());
      expect(await readJson<Manifest>(archive, `${prefix}manifest.json`)).toMatchObject({ scope: { type: "subdivision", dataVersion: 2, previousDataVersion: 1 } });
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
