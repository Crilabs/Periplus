import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Archive } from "@/lib/adapters/s3";
import { CONTRACT_SCHEMAS, SCHEMA_VERSION, type CoastCollection, type ContractFile, type Manifest, type SpotsFile } from "@/contract";
import { manifestSchema } from "@/contract/v2";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, radiusPackageRequests, radiusPackages, subdivisions } from "@/lib/db/schema";
import { newId, newPublicId } from "@/lib/domain/ids";
import { startWhileLocked, testDb, withRollback } from "@/test/db";
import {
  EAST,
  eastPackage,
  insertNamedSubdivision,
  insertSecondSubdivision,
  randomPackageIds,
  storeSubdivisionPackage,
} from "@/test/fixtures/delivery/radius";
import { seedDeliverySubdivision, type DeliveryFixture } from "@/test/fixtures/delivery/subdivision";
import { memoryArchive } from "@/test/s3";
import { buildDelivery } from "../../build";
import { distanceNm } from "../../geo";
import { sha256Hex } from "../../serialize";
import type { DeliveryPackage } from "../../types";
import { getRadiusPackage, radiusPackageByKey, radiusPackageKey, readRadiusFile, type RadiusPackageRow } from "../build";
import { clipCoast } from "../coast";
import { circlePolygon, destination } from "../geometry";

/*
 * Radius packages built, stored and cached (spec 18, plan Task 5) on the delivery fixture (its package built for real)
 * and a second subdivision east of it (`eastPackage`, stored without a build), in `withRollback` with an in-memory
 * archive. One test commits (two pool connections must see the same subdivisions): random ids far from every other
 * test box, the subdivision ended afterwards.
 */

const NOW = new Date("2040-06-01T08:00:00Z");
const cfg = getConfig().delivery;
const IMAGE = `images/${EAST.spot}-title.jpg`;
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const decoder = new TextDecoder();

type Setup = { f: DeliveryFixture; eastId: string; archive: ReturnType<typeof memoryArchive> };

/** The fixture with its first package built, the second subdivision with (`east`) or without its first package. */
async function setup(tx: Db, o: { east: boolean }): Promise<Setup> {
  const archive = memoryArchive();
  const f = await seedDeliverySubdivision(tx);
  const built = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
  expect(built.status).toBe("valid");
  const east = await insertSecondSubdivision(tx);
  if (o.east) await storeSubdivisionPackage(tx, archive, { subdivisionId: east.id, pkg: eastPackage(), dataVersion: 1, images: { [IMAGE]: IMAGE_BYTES } });
  return { f, eastId: east.id, archive };
}

function isRow(r: RadiusPackageRow | string): asserts r is RadiusPackageRow {
  if (typeof r === "string") throw new Error(`expected a radius package, got ${r}`);
}

async function readJson<T>(archive: Archive, row: RadiusPackageRow, file: string): Promise<T> {
  const bytes = await readRadiusFile(archive, row, file);
  if (bytes === null) throw new Error(`no ${file}`);
  return JSON.parse(decoder.decode(bytes)) as T;
}

/** The stored package of a subdivision delivery as a `DeliveryPackage` (to store a changed next version). */
async function storedPackage(archive: Archive, prefix: string): Promise<DeliveryPackage> {
  const read = async (file: string) => JSON.parse(decoder.decode((await archive.get(prefix + file))!)) as unknown;
  const files = Object.fromEntries(
    await Promise.all(["spots.json", "highlights.json", "regions.json", "coast.geojson", "weather-points.json"].map(async (f) => [f, await read(f)] as const)),
  );
  return { manifest: (await read("manifest.json")) as Manifest, files: files as DeliveryPackage["files"] };
}

const countRows = async (tx: Db, key: string) => (await tx.select().from(radiusPackages).where(eq(radiusPackages.key, key))).length;

describe("radiusPackageKey", () => {
  const coverage = [
    { id: "sd_01J9ZE00000000000000000001", key: "B", name: "b", status: "delivered" as const, dataVersion: 3 },
    { id: "sd_01J9ZD00000000000000000001", key: "A", name: "a", status: "missing" as const, dataVersion: null },
  ];
  const input = { marina: "sp_01J9ZD00000000000000000002", days: 7, radiusNm: 175, coverage, schemaVersion: "3.0" };

  it("is the first 16 hex characters of the sha256 over marina, days, radius, version and the sorted coverage", () => {
    const text = "sp_01J9ZD00000000000000000002|7|175|3.0|sd_01J9ZD00000000000000000001:missing|sd_01J9ZE00000000000000000001:3";
    expect(radiusPackageKey(input)).toBe(sha256Hex(new TextEncoder().encode(text)).slice(0, 16));
    expect(radiusPackageKey({ ...input, coverage: [...coverage].reverse() })).toBe(radiusPackageKey(input));
  });

  it("changes with every input", () => {
    const key = radiusPackageKey(input);
    expect(radiusPackageKey({ ...input, days: 8 })).not.toBe(key);
    expect(radiusPackageKey({ ...input, schemaVersion: "3.1" })).not.toBe(key);
    expect(radiusPackageKey({ ...input, coverage: [coverage[0]!, { ...coverage[1]!, status: "delivered", dataVersion: 1 }] })).not.toBe(key);
  });
});

describe("getRadiusPackage", () => {
  it("builds the 7-day package of a marina from both subdivisions and stores it with its hashes", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { f, archive } = await setup(tx, { east: true });
      const marina = f.places.M.publicId!;
      const row = await getRadiusPackage(tx, archive, { marina, days: 7, now: NOW });
      isRow(row);

      const coverage = [
        { id: f.subdivisionPublicId, key: "XT-DELIVERY", name: "Testlandesteil", status: "delivered", dataVersion: 1 },
        { id: EAST.subdivisionId, key: EAST.key, name: EAST.name, status: "delivered", dataVersion: 1 },
      ];
      expect(row).toMatchObject({
        homeMarinaPublicId: marina,
        days: 7,
        radiusNm: 175,
        coverage,
        schemaVersion: SCHEMA_VERSION,
        generatedAt: NOW,
        storagePrefix: `deliveries/radius/${marina}/7/${row.key}/`,
        warnings: [],
      });
      expect(row.key).toBe(radiusPackageKey({ marina, days: 7, radiusNm: 175, coverage: row.coverage, schemaVersion: SCHEMA_VERSION }));
      expect(row.key).toMatch(/^[0-9a-f]{16}$/);

      // every stored file matches its recorded hash; the manifest lists every other file with the same hash
      const manifest = manifestSchema.parse(await readJson<Manifest>(archive, row, "manifest.json"));
      expect(manifest.scope).toMatchObject({ type: "radius", key: row.key, homeMarina: { id: marina }, days: 7, radiusNm: 175 });
      expect(manifest.coverage).toEqual(coverage);
      for (const [name, hash] of Object.entries(row.fileHashes)) {
        const bytes = (await archive.get(`${row.storagePrefix}${name}`))!;
        expect({ sha256: sha256Hex(bytes), bytes: bytes.byteLength }, name).toEqual(hash);
      }
      expect(Object.fromEntries(manifest.files.map((e) => [e.name, { sha256: e.sha256, bytes: e.bytes }]))).toEqual(
        Object.fromEntries(Object.entries(row.fileHashes).filter(([name]) => name !== "manifest.json")),
      );
      expect(Object.keys(row.fileHashes).sort()).toEqual(
        ["coast.geojson", "highlights.json", IMAGE, "manifest.json", "regions.json", "spots.json", "weather-points.json"].sort(),
      );
      for (const file of ["spots.json", "highlights.json", "regions.json", "coast.geojson", "weather-points.json"] as ContractFile[]) {
        const parsed = CONTRACT_SCHEMAS[file].safeParse(await readJson(archive, row, file));
        expect(parsed.success, `${file}: ${JSON.stringify(parsed.error?.issues.slice(0, 3))}`).toBe(true);
      }
      expect(manifest.objectCounts.changes).toBe(0);
      expect(row.objectCounts).toEqual(manifest.objectCounts);

      // objects of both subdivisions; the image copied from the east package's prefix
      const spotIds = (await readJson<SpotsFile>(archive, row, "spots.json")).spots.map((s) => s.id);
      expect(spotIds).toEqual(expect.arrayContaining([marina, f.places.A.publicId, EAST.spot, EAST.marina]));
      expect(await readRadiusFile(archive, row, IMAGE)).toEqual(IMAGE_BYTES);
      expect(await readRadiusFile(archive, row, "changes.json")).toBeNull();

      // one request row of kind `package`
      expect(await tx.select().from(radiusPackageRequests).where(eq(radiusPackageRequests.radiusPackageId, row.id))).toEqual([
        expect.objectContaining({ kind: "package", apiClientId: null }),
      ]);
      expect(await radiusPackageByKey(tx, row.key)).toEqual(row);
      expect(await radiusPackageByKey(tx, "0000000000000000")).toBeNull();
    }));

  it("the same inputs give the same row without a second build, and one request row per call", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { f, archive } = await setup(tx, { east: true });
      const marina = f.places.M.publicId!;
      const first = await getRadiusPackage(tx, archive, { marina, days: 3, now: NOW });
      isRow(first);
      const keys = archive.keys();
      const second = await getRadiusPackage(tx, archive, { marina, days: 3, kind: "file", now: new Date("2040-06-02T08:00:00Z") });
      isRow(second);
      expect(second).toEqual(first);
      expect(archive.keys()).toEqual(keys);
      expect(await countRows(tx, first.key)).toBe(1);
      const requests = await tx.select().from(radiusPackageRequests).where(eq(radiusPackageRequests.radiusPackageId, first.id));
      expect(requests.map((r) => r.kind).sort()).toEqual(["file", "package"]);
      // both tables are append-only
      await expect(tx.transaction((sp) => sp.execute(sql`update radius_packages set days = 4 where id = ${first.id}`))).rejects.toThrow();
      await expect(tx.transaction((sp) => sp.execute(sql`delete from radius_package_requests where radius_package_id = ${first.id}`))).rejects.toThrow();
    }));

  it("a second request waits for the build lock of the key (radius:<key>)", { timeout: 60_000 }, async () => {
    const key = radiusPackageKey({
      marina: "sp_01J9ZD00000000000000000002",
      days: 7,
      radiusNm: 175,
      coverage: [
        { id: "sd_01J9ZD00000000000000000001", key: "XT-DELIVERY", name: "Testlandesteil", status: "delivered", dataVersion: 1 },
        { id: EAST.subdivisionId, key: EAST.key, name: EAST.name, status: "delivered", dataVersion: 1 },
      ],
      schemaVersion: SCHEMA_VERSION,
    });
    await expect(
      startWhileLocked(testDb(), `radius:${key}`, async (tx) => {
        const { f, archive } = await setup(tx, { east: true });
        expect(f.places.M.publicId).toBe("sp_01J9ZD00000000000000000002");
        return getRadiusPackage(tx, archive, { marina: f.places.M.publicId!, days: 7, now: NOW });
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "55P03" }) });
  });

  it("two concurrent requests on two pool connections build once and return the same key", { timeout: 60_000 }, async () => {
    // committed (both connections must see the subdivision): random ids around −130° / −55°, far from every other test box
    const db = testDb();
    const archive = memoryArchive();
    const subdivision = { publicId: newPublicId("sd"), key: `XT-RADIUS-${newId()}`, name: "Radiustest" };
    const ids = randomPackageIds(subdivision, "q025:200:140");
    let created: { id: string } | undefined;
    try {
      await db.transaction(async (tx) => {
        created = await insertNamedSubdivision(tx, { ...subdivision, box: [-130.25, -55.25, -129.75, -54.75] });
        await storeSubdivisionPackage(tx, archive, { subdivisionId: created.id, pkg: eastPackage(ids, { lon: -151.05, lat: -90.2 }), dataVersion: 1 });
      });
      const [a, b] = await Promise.all([
        getRadiusPackage(db, archive, { marina: ids.marina, days: 1, now: NOW }),
        getRadiusPackage(db, archive, { marina: ids.marina, days: 1, now: NOW }),
      ]);
      isRow(a);
      isRow(b);
      expect(b.key).toBe(a.key);
      expect(b.id).toBe(a.id);
      expect(await countRows(db, a.key)).toBe(1);
      expect(await db.select().from(radiusPackageRequests).where(eq(radiusPackageRequests.radiusPackageId, a.id))).toHaveLength(2);
    } finally {
      if (created) {
        const [row] = await db.select({ geoObjectId: subdivisions.geoObjectId }).from(subdivisions).where(eq(subdivisions.id, created.id));
        await db.update(subdivisions).set({ validTo: sql`current_date` }).where(eq(subdivisions.id, created.id));
        await db.update(geoObjects).set({ validTo: sql`current_date` }).where(eq(geoObjects.id, row!.geoObjectId));
      }
    }
  });

  it("a missing subdivision, then each new package of it gives a new key and a new row", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { f, eastId, archive } = await setup(tx, { east: false });
      const marina = f.places.M.publicId!;
      const missing = await getRadiusPackage(tx, archive, { marina, days: 7, now: NOW });
      isRow(missing);
      expect(missing.coverage).toEqual([
        expect.objectContaining({ id: f.subdivisionPublicId, status: "delivered", dataVersion: 1 }),
        { id: EAST.subdivisionId, key: EAST.key, name: EAST.name, status: "missing", dataVersion: null },
      ]);
      const manifest = await readJson<Manifest>(archive, missing, "manifest.json");
      expect(manifest.tiles).toContainEqual({ id: EAST.tileId, lastRunAt: null, profilesAsOf: null });

      await storeSubdivisionPackage(tx, archive, { subdivisionId: eastId, pkg: eastPackage(), dataVersion: 1 });
      const v1 = await getRadiusPackage(tx, archive, { marina, days: 7, now: NOW });
      isRow(v1);
      await storeSubdivisionPackage(tx, archive, { subdivisionId: eastId, pkg: eastPackage(), dataVersion: 2 });
      const v2 = await getRadiusPackage(tx, archive, { marina, days: 7, now: NOW });
      isRow(v2);
      expect(new Set([missing.key, v1.key, v2.key]).size).toBe(3);
      expect(v2.coverage[1]).toMatchObject({ status: "delivered", dataVersion: 2 });
      expect(await tx.select().from(radiusPackages).where(and(eq(radiusPackages.homeMarinaPublicId, marina), eq(radiusPackages.days, 7)))).toHaveLength(3);
    }));

  it("an excluded subdivision the circle touches is missing, though it has an old valid package", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { f, eastId, archive } = await setup(tx, { east: true });
      await tx.update(subdivisions).set({ status: "excluded" }).where(eq(subdivisions.id, eastId));
      const row = await getRadiusPackage(tx, archive, { marina: f.places.M.publicId!, days: 7, now: NOW });
      isRow(row);
      expect(row.coverage).toEqual([
        expect.objectContaining({ id: f.subdivisionPublicId, status: "delivered", dataVersion: 1 }),
        { id: EAST.subdivisionId, key: EAST.key, name: EAST.name, status: "missing", dataVersion: null },
      ]);
      const manifest = await readJson<Manifest>(archive, row, "manifest.json");
      expect(manifest.tiles).toContainEqual({ id: EAST.tileId, lastRunAt: null, profilesAsOf: null });
      // nothing of its package is in the radius package
      const spotIds = (await readJson<SpotsFile>(archive, row, "spots.json")).spots.map((s) => s.id);
      expect(spotIds).not.toContain(EAST.spot);
    }));

  it("a merged spot follows its target; a dangling mergedInto or highlightIds reference throws and stores nothing", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { f, eastId, archive } = await setup(tx, { east: false });
      const marina = f.places.M.publicId!;
      const far = (p: { lat: number; lon: number }) => ({ ...p, lat: p.lat + 2 });
      // version 1: the east anchorage (13.5 nm from M) merged into the east marina, moved 2° north (outside 25 nm): the
      // anchorage follows its target out of the package, the build succeeds
      const merged = eastPackage();
      const spots = merged.files["spots.json"].spots;
      const marinaE = spots.find((s) => s.id === EAST.marina)!;
      marinaE.position = far(marinaE.position);
      spots.find((s) => s.id === EAST.spot)!.mergedInto = EAST.marina;
      await storeSubdivisionPackage(tx, archive, { subdivisionId: eastId, pkg: merged, dataVersion: 1 });
      const v1 = await getRadiusPackage(tx, archive, { marina, days: 1, now: NOW });
      isRow(v1);
      const v1Spots = (await readJson<SpotsFile>(archive, v1, "spots.json")).spots.map((s) => s.id);
      expect(v1Spots).toContain(marina);
      expect(v1Spots).not.toContain(EAST.spot);
      expect(v1Spots).not.toContain(EAST.marina);

      // version 2: the anchorage merged into a spot that is in no package
      const dangling = eastPackage();
      const ghost = newPublicId("sp");
      dangling.files["spots.json"].spots.find((s) => s.id === EAST.spot)!.mergedInto = ghost;
      await storeSubdivisionPackage(tx, archive, { subdivisionId: eastId, pkg: dangling, dataVersion: 2 });
      await expect(tx.transaction((sp) => getRadiusPackage(sp, archive, { marina, days: 1, now: NOW }))).rejects.toThrow(
        new RegExp(`references outside the package: .*${EAST.spot} → ${ghost}`),
      );

      // version 3: the anchorage lists the highlight, which only the far marina selects and which lies far away
      const listed = eastPackage();
      const marina2 = listed.files["spots.json"].spots.find((s) => s.id === EAST.marina)!;
      marina2.position = far(marina2.position);
      const highlight = listed.files["highlights.json"].highlights[0]!;
      highlight.spotIds = [EAST.marina];
      highlight.position = far(highlight.position);
      expect(listed.files["spots.json"].spots.find((s) => s.id === EAST.spot)!.highlightIds).toEqual([EAST.highlight]);
      await storeSubdivisionPackage(tx, archive, { subdivisionId: eastId, pkg: listed, dataVersion: 3 });
      await expect(tx.transaction((sp) => getRadiusPackage(sp, archive, { marina, days: 1, now: NOW }))).rejects.toThrow(
        new RegExp(`references outside the package: .*${EAST.spot} → ${EAST.highlight}`),
      );
      // only the package of version 1 is stored
      expect((await tx.select().from(radiusPackages).where(eq(radiusPackages.homeMarinaPublicId, marina))).map((r) => r.id)).toEqual([v1.id]);
    }));

  it("rejects an anchorage, an unknown spot and an invalid trip length", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { f, archive } = await setup(tx, { east: false });
      expect(await getRadiusPackage(tx, archive, { marina: f.places.A.publicId!, days: 7, now: NOW })).toBe("marina_not_found");
      expect(await getRadiusPackage(tx, archive, { marina: newPublicId("sp"), days: 7, now: NOW })).toBe("marina_not_found");
      for (const days of [0, 29, 1.5, Number.NaN]) {
        expect(await getRadiusPackage(tx, archive, { marina: f.places.M.publicId!, days, now: NOW }), String(days)).toBe("invalid_days");
      }
      expect(await tx.select().from(radiusPackages).where(eq(radiusPackages.homeMarinaPublicId, f.places.M.publicId!))).toEqual([]);
    }));

  it("a marina excluded or gone in its subdivision's current package gets no package, though an older one is cached", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { f, archive } = await setup(tx, { east: false });
      const marina = f.places.M.publicId!;
      const old = await getRadiusPackage(tx, archive, { marina, days: 2, now: NOW });
      isRow(old);

      // version 2: the marina excluded
      const v1 = await storedPackage(archive, `deliveries/${f.subdivisionKey}/1/`);
      const excluded = structuredClone(v1);
      const m = excluded.files["spots.json"].spots.find((s) => s.id === marina)!;
      m.exclude = { excluded: true, reason: "military", detail: null };
      m.profileVersion += 1;
      await storeSubdivisionPackage(tx, archive, { subdivisionId: f.subdivisionId, pkg: excluded, dataVersion: 2 });
      expect(await getRadiusPackage(tx, archive, { marina, days: 2, now: NOW })).toBe("marina_not_found");
      expect(await radiusPackageByKey(tx, old.key)).toEqual(old);

      // version 3: the marina no longer in the package
      const gone = structuredClone(v1);
      gone.files["spots.json"].spots = gone.files["spots.json"].spots.filter((s) => s.id !== marina);
      await storeSubdivisionPackage(tx, archive, { subdivisionId: f.subdivisionId, pkg: gone, dataVersion: 3 });
      expect(await getRadiusPackage(tx, archive, { marina, days: 2, now: NOW })).toBe("marina_not_found");
    }));

  it("readRadiusFile refuses bytes that do not match the recorded hash", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { f, archive } = await setup(tx, { east: false });
      const row = await getRadiusPackage(tx, archive, { marina: f.places.M.publicId!, days: 1, now: NOW });
      isRow(row);
      expect(await readRadiusFile(archive, row, "images/unknown.jpg")).toBeNull();
      await archive.put(`${row.storagePrefix}spots.json`, new TextEncoder().encode("{}"), "application/json");
      await expect(readRadiusFile(archive, row, "spots.json")).rejects.toThrow(/does not match its hash/);
    }));
});

describe("clipCoast", () => {
  const center = { lon: 21.3, lat: 35.1 };
  const r = 25;
  const limit = r + cfg.coast.marginNm;
  const land = (coordinates: Array<[number, number]>, extractedAt: string) => ({
    type: "Feature" as const,
    geometry: { type: "Polygon" as const, coordinates: [coordinates] },
    properties: { kind: "land" as const, source: "OpenStreetMap, ODbL", extractedAt },
  });
  const box = (w: number, s: number, e: number, n: number): Array<[number, number]> => [[w, s], [e, s], [e, n], [w, n], [w, s]];

  it("keeps land, coastline and restricted areas within the circle plus the margin, cut there, restricted areas once", () =>
    withRollback(async (tx) => {
      const east = destination(center, 90, limit).lon;
      const restricted = {
        type: "Feature" as const,
        geometry: { type: "Polygon" as const, coordinates: [box(21.2, 35.0, 21.25, 35.05)] },
        properties: { kind: "restrictedArea" as const, reason: "military" as const, source: "test" },
      };
      const a: CoastCollection = {
        type: "FeatureCollection",
        features: [
          // crossing the buffered circle eastwards
          land(box(21.3, 35.09, east + 0.2, 35.11), "2026-09-30"),
          { type: "Feature", geometry: { type: "LineString", coordinates: [[21.3, 35.12], [east + 0.2, 35.12]] }, properties: { kind: "coastline", source: "OpenStreetMap, ODbL", extractedAt: "2026-09-30" } },
          restricted,
        ],
      };
      const b: CoastCollection = {
        type: "FeatureCollection",
        features: [
          // entirely outside: well beyond the buffered circle to the east
          land(box(east + 0.1, 35.2, east + 0.2, 35.3), "2026-10-02"),
          restricted,
        ],
      };
      const out = await clipCoast(tx, [a, b], circlePolygon(center, r), cfg.coast.marginNm, cfg.coast.simplifyToleranceM);
      expect(CONTRACT_SCHEMAS["coast.geojson"].safeParse(out).success).toBe(true);
      expect(out.features.map((f) => f.properties.kind)).toEqual(["land", "coastline", "restrictedArea"]);
      const positions = (c: unknown): number[][] => (Array.isArray(c) && typeof c[0] === "number" ? [c as number[]] : Array.isArray(c) ? c.flatMap(positions) : []);
      for (const f of out.features) {
        for (const [lon, lat] of positions(f.geometry.coordinates)) expect(distanceNm(center, { lon: lon!, lat: lat! })).toBeLessThanOrEqual(limit + 0.01);
      }
      // the crossing land is cut near the buffer edge, not dropped
      const landLons = positions(out.features[0]!.geometry.coordinates).map(([lon]) => lon!);
      expect(Math.max(...landLons)).toBeGreaterThan(east - 0.01);
      expect(out.features[0]!.properties).toEqual({ kind: "land", source: "OpenStreetMap, ODbL", extractedAt: "2026-10-02" });
      expect(out.features[2]!.properties).toEqual({ kind: "restrictedArea", reason: "military", source: "test" });
    }));
});
