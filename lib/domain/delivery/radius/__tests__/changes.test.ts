import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Archive } from "@/lib/adapters/s3";
import type { ChangeEntry, ChangesFile, HighlightsFile, Manifest, RegionsFile, SpotsFile } from "@/contract/v3_0";
import type { Db } from "@/lib/db/client";
import { radiusPackageRequests, radiusPackages, subdivisions } from "@/lib/db/schema";
import { withRollback } from "@/test/db";
import { EAST, eastPackage, insertSecondSubdivision, storeSubdivisionPackage } from "@/test/fixtures/delivery/radius";
import { seedDeliverySubdivision, type DeliveryFixture } from "@/test/fixtures/delivery/subdivision";
import { memoryArchive } from "@/test/s3";
import { buildDelivery } from "../../build";
import type { DeliveryPackage } from "../../types";
import { getRadiusPackage, readRadiusFile, type RadiusPackageRow } from "../build";
import { radiusChangesSince } from "../changes";

/*
 * Changes since a radius package (spec 18 "Änderungen nach dem Törn", plan Task 6) on the delivery fixture (built for
 * real) and the second subdivision east of it (`eastPackage`, stored with a hand-written `changes.json`), in
 * `withRollback` with an in-memory archive. One day: a 25 nm circle around the fixture's marina, which holds the east
 * anchorage (13.5 nm away).
 */

const NOW = new Date("2040-06-01T08:00:00Z");
const DAYS = 1;
const decoder = new TextDecoder();

type Setup = { f: DeliveryFixture; marina: string; eastId: string; archive: ReturnType<typeof memoryArchive> };

async function setup(tx: Db, o: { east: boolean }): Promise<Setup> {
  const archive = memoryArchive();
  const f = await seedDeliverySubdivision(tx);
  const built = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
  expect(built.status).toBe("valid");
  const east = await insertSecondSubdivision(tx);
  if (o.east) await storeSubdivisionPackage(tx, archive, { subdivisionId: east.id, pkg: eastPackage(), dataVersion: 1 });
  return { f, marina: f.places.M.publicId!, eastId: east.id, archive };
}

function isRow(r: RadiusPackageRow | string): asserts r is RadiusPackageRow {
  if (typeof r === "string") throw new Error(`expected a radius package, got ${r}`);
}

function isChanges(r: { key: string; changes: ChangeEntry[] } | string): asserts r is { key: string; changes: ChangeEntry[] } {
  if (typeof r === "string") throw new Error(`expected changes, got ${r}`);
}

async function readJson<T>(archive: Archive, row: RadiusPackageRow, file: string): Promise<T> {
  const bytes = await readRadiusFile(archive, row, file);
  if (bytes === null) throw new Error(`no ${file}`);
  return JSON.parse(decoder.decode(bytes)) as T;
}

/** The `type:id` of every spot, highlight and region of a radius package. */
async function objectIds(archive: Archive, row: RadiusPackageRow): Promise<Set<string>> {
  const spots = await readJson<SpotsFile>(archive, row, "spots.json");
  const highlights = await readJson<HighlightsFile>(archive, row, "highlights.json");
  const regions = await readJson<RegionsFile>(archive, row, "regions.json");
  return new Set([
    ...spots.spots.map((s) => `spot:${s.id}`),
    ...highlights.highlights.map((h) => `highlight:${h.id}`),
    ...regions.regions.map((r) => `region:${r.id}`),
  ]);
}

/** (d): the old package's objects plus `created` minus `removed` are the new package's objects. */
async function expectConsistent(archive: Archive, old: RadiusPackageRow, current: RadiusPackageRow, changes: ChangeEntry[]) {
  const ids = await objectIds(archive, old);
  for (const c of changes) {
    if (c.event === "created") ids.add(`${c.objectType}:${c.objectId}`);
    if (c.event === "removed") ids.delete(`${c.objectType}:${c.objectId}`);
  }
  expect([...ids].sort()).toEqual([...(await objectIds(archive, current))].sort());
}

/** `pkg` with a `changes.json` holding `changes` (scope and time set by `storeSubdivisionPackage`). */
function withChanges(pkg: DeliveryPackage, changes: ChangeEntry[]): DeliveryPackage {
  const { schemaVersion, scope, generatedAt } = pkg.files["spots.json"];
  const file: ChangesFile = { schemaVersion, scope, generatedAt, previousDataVersion: 1, changes };
  return { ...pkg, files: { ...pkg.files, "changes.json": file } };
}

/** The stored package of a subdivision delivery as a `DeliveryPackage` (to store a changed next version). */
async function storedPackage(archive: Archive, prefix: string): Promise<DeliveryPackage> {
  const read = async (file: string) => JSON.parse(decoder.decode((await archive.get(prefix + file))!)) as unknown;
  const files = Object.fromEntries(
    await Promise.all(["spots.json", "highlights.json", "regions.json", "coast.geojson", "weather-points.json"].map(async (f) => [f, await read(f)] as const)),
  );
  return { manifest: (await read("manifest.json")) as Manifest, files: files as DeliveryPackage["files"] };
}

/**
 * Ruling M6-P13 on two subdivisions: the east anchorage moves to the fixture's subdivision (B), which delivers it with
 * `profileVersion + 1` from its version 2 on (feed `created`); the east subdivision (A) keeps delivering it stale until
 * its version 2 drops it (feed `removed`). `oldAfterB`: the old radius package is built after B's version 2.
 */
async function movedBetweenSubdivisions(tx: Db, oldAfterB: boolean) {
  const { f, marina, eastId, archive } = await setup(tx, { east: true });
  const stale = eastPackage().files["spots.json"].spots.find((s) => s.id === EAST.spot)!;
  const moved = { ...structuredClone(stale), profileVersion: stale.profileVersion + 1 };
  const created: ChangeEntry = {
    objectType: "spot",
    objectId: EAST.spot,
    event: "created",
    fields: [],
    severity: "info",
    summary: { de: "Neu im Paket." },
    profileVersion: moved.profileVersion,
  };
  const b2 = await storedPackage(archive, `deliveries/${f.subdivisionKey}/1/`);
  b2.files["spots.json"].spots.push(moved);
  const storeB2 = () => storeSubdivisionPackage(tx, archive, { subdivisionId: f.subdivisionId, pkg: withChanges(b2, [created]), dataVersion: 2 });

  if (oldAfterB) await storeB2();
  const old = await getRadiusPackage(tx, archive, { marina, days: DAYS, now: NOW });
  isRow(old);
  if (!oldAfterB) await storeB2();
  const a2 = eastPackage();
  a2.files["spots.json"].spots = a2.files["spots.json"].spots.filter((s) => s.id !== EAST.spot);
  const removed: ChangeEntry = { ...created, event: "removed", severity: "notable", summary: { de: "Nicht mehr im Paket." }, profileVersion: stale.profileVersion };
  await storeSubdivisionPackage(tx, archive, { subdivisionId: eastId, pkg: withChanges(a2, [removed]), dataVersion: 2 });

  const result = await radiusChangesSince(tx, archive, { marina, days: DAYS, since: old.key });
  isChanges(result);
  const current = await getRadiusPackage(tx, archive, { marina, days: DAYS, now: NOW });
  isRow(current);
  const version = async (row: RadiusPackageRow) => (await readJson<SpotsFile>(archive, row, "spots.json")).spots.find((s) => s.id === EAST.spot)?.profileVersion;
  return { archive, old, current, result, versions: [await version(old), await version(current)], moved };
}

const UNRELATED = "sp_01J9ZE0000000000000000000Z";

describe("radiusChangesSince", () => {
  it("(a) a spot in the circle changed and its subdivision rebuilt gives the feed's `updated`", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { marina, eastId, archive } = await setup(tx, { east: true });
      const old = await getRadiusPackage(tx, archive, { marina, days: DAYS, now: NOW });
      isRow(old);

      const v2 = eastPackage();
      const spot = v2.files["spots.json"].spots.find((s) => s.id === EAST.spot)!;
      spot.profileVersion += 1;
      spot.shelter.sectors.N = spot.shelter.sectors.N === 1 ? 0.5 : 1;
      const updated: ChangeEntry = {
        objectType: "spot",
        objectId: EAST.spot,
        event: "updated",
        fields: ["shelter.sectors.N"],
        severity: "safety",
        summary: { de: "Geändert: Schutz." },
        profileVersion: spot.profileVersion,
      };
      // an entry for an object in neither package is dropped
      const unrelated: ChangeEntry = { ...updated, objectId: UNRELATED };
      await storeSubdivisionPackage(tx, archive, { subdivisionId: eastId, pkg: withChanges(v2, [updated, unrelated]), dataVersion: 2 });

      const result = await radiusChangesSince(tx, archive, { marina, days: DAYS, since: old.key });
      isChanges(result);
      expect(result.key).not.toBe(old.key);
      expect(result.changes).toEqual([updated]);
      const current = await getRadiusPackage(tx, archive, { marina, days: DAYS, now: NOW });
      isRow(current);
      expect(current.key).toBe(result.key);
      await expectConsistent(archive, old, current, result.changes);
    }));

  it("(b) a subdivision missing before and built now brings its objects in the circle as `created`", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { marina, eastId, archive } = await setup(tx, { east: false });
      const old = await getRadiusPackage(tx, archive, { marina, days: DAYS, now: NOW });
      isRow(old);
      await storeSubdivisionPackage(tx, archive, { subdivisionId: eastId, pkg: eastPackage(), dataVersion: 1 });

      const result = await radiusChangesSince(tx, archive, { marina, days: DAYS, since: old.key });
      isChanges(result);
      const current = await getRadiusPackage(tx, archive, { marina, days: DAYS, now: NOW });
      isRow(current);
      const spots = (await readJson<SpotsFile>(archive, current, "spots.json")).spots;
      const eastSpot = spots.find((s) => s.id === EAST.spot)!;
      expect(result.changes).toContainEqual({
        objectType: "spot",
        objectId: EAST.spot,
        event: "created",
        fields: [],
        severity: "info",
        summary: { de: "Neu im Umkreis" },
        profileVersion: eastSpot.profileVersion,
      });
      expect(result.changes.every((c) => c.event === "created" && c.summary.de === "Neu im Umkreis" && c.fields.length === 0)).toBe(true);
      // sorted by type, then id
      const order = result.changes.map((c) => `${c.objectType}:${c.objectId}`);
      expect(order).toEqual([...order].sort());
      await expectConsistent(archive, old, current, result.changes);
    }));

  it("(c) a spot moved out of the circle by a correction is `removed`, though its feed says `updated`", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { marina, eastId, archive } = await setup(tx, { east: true });
      const old = await getRadiusPackage(tx, archive, { marina, days: DAYS, now: NOW });
      isRow(old);
      const oldSpot = (await readJson<SpotsFile>(archive, old, "spots.json")).spots.find((s) => s.id === EAST.spot)!;

      const v2 = eastPackage();
      const spot = v2.files["spots.json"].spots.find((s) => s.id === EAST.spot)!;
      spot.position = { ...spot.position, lat: spot.position.lat + 2 };
      spot.profileVersion += 1;
      const moved: ChangeEntry = {
        objectType: "spot",
        objectId: EAST.spot,
        event: "updated",
        fields: ["position"],
        severity: "info",
        summary: { de: "Geändert: Position." },
        profileVersion: spot.profileVersion,
      };
      await storeSubdivisionPackage(tx, archive, { subdivisionId: eastId, pkg: withChanges(v2, [moved]), dataVersion: 2 });

      const result = await radiusChangesSince(tx, archive, { marina, days: DAYS, since: old.key });
      isChanges(result);
      expect(result.changes).toContainEqual({
        objectType: "spot",
        objectId: EAST.spot,
        event: "removed",
        fields: [],
        severity: "info",
        summary: { de: "Nicht mehr im Umkreis" },
        profileVersion: oldSpot.profileVersion,
      });
      expect(result.changes.filter((c) => c.objectId === EAST.spot)).toHaveLength(1);
      const current = await getRadiusPackage(tx, archive, { marina, days: DAYS, now: NOW });
      isRow(current);
      await expectConsistent(archive, old, current, result.changes);
    }));

  it("a subdivision excluded since the old package drops its objects as `removed`", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { marina, eastId, archive } = await setup(tx, { east: true });
      const old = await getRadiusPackage(tx, archive, { marina, days: DAYS, now: NOW });
      isRow(old);
      await tx.update(subdivisions).set({ status: "excluded" }).where(eq(subdivisions.id, eastId));

      const result = await radiusChangesSince(tx, archive, { marina, days: DAYS, since: old.key });
      isChanges(result);
      expect(result.changes.length).toBeGreaterThan(0);
      expect(result.changes.every((c) => c.event === "removed" && c.summary.de === "Nicht mehr im Umkreis")).toBe(true);
      expect(result.changes.map((c) => c.objectId)).toContain(EAST.spot);
      const current = await getRadiusPackage(tx, archive, { marina, days: DAYS, now: NOW });
      isRow(current);
      await expectConsistent(archive, old, current, result.changes);
    }));

  it("a spot moved between subdivisions, in both packages at the same version, has no entry (not the stale `removed`)", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { archive, old, current, result, versions, moved } = await movedBetweenSubdivisions(tx, true);
      expect(versions).toEqual([moved.profileVersion, moved.profileVersion]);
      expect(result.changes.filter((c) => c.objectId === EAST.spot)).toEqual([]);
      await expectConsistent(archive, old, current, result.changes);
    }));

  it("a spot moved between subdivisions at a new version is `updated`, never `created` or `removed`", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { archive, old, current, result, versions, moved } = await movedBetweenSubdivisions(tx, false);
      expect(versions).toEqual([moved.profileVersion - 1, moved.profileVersion]);
      expect(result.changes.filter((c) => c.objectId === EAST.spot)).toEqual([
        {
          objectType: "spot",
          objectId: EAST.spot,
          event: "updated",
          fields: [],
          severity: "info",
          summary: { de: "Geändert." },
          profileVersion: moved.profileVersion,
        },
      ]);
      await expectConsistent(archive, old, current, result.changes);
    }));

  it("a subdivision whose feed cannot be read from the old version is `invalid_since`", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { marina, eastId, archive } = await setup(tx, { east: true });
      const old = await getRadiusPackage(tx, archive, { marina, days: DAYS, now: NOW });
      isRow(old);

      // the old package names a version above the subdivision's current one (version gone back)
      const ahead = old.coverage.map((c) => (c.id === EAST.subdivisionId ? { ...c, status: "delivered" as const, dataVersion: 5 } : c));
      await tx.insert(radiusPackages).values({ ...old, id: undefined, key: "ffffffffffffffff", coverage: ahead });
      expect(await radiusChangesSince(tx, archive, { marina, days: DAYS, since: "ffffffffffffffff" })).toBe("invalid_since");

      // version 2 is not valid: the subdivision's valid versions jump from 1 to 3
      await storeSubdivisionPackage(tx, archive, { subdivisionId: eastId, pkg: withChanges(eastPackage(), []), dataVersion: 3 });
      expect(await radiusChangesSince(tx, archive, { marina, days: DAYS, since: old.key })).toBe("invalid_since");
    }));

  it("(e) `since` of a package for other days or another marina, or an unknown key, is `invalid_since`", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { marina, archive } = await setup(tx, { east: true });
      const other = await getRadiusPackage(tx, archive, { marina, days: DAYS + 1, now: NOW });
      isRow(other);
      expect(await radiusChangesSince(tx, archive, { marina, days: DAYS, since: other.key })).toBe("invalid_since");
      const otherMarina = await getRadiusPackage(tx, archive, { marina: EAST.marina, days: DAYS, now: NOW });
      isRow(otherMarina);
      expect(await radiusChangesSince(tx, archive, { marina, days: DAYS, since: otherMarina.key })).toBe("invalid_since");
      expect(await radiusChangesSince(tx, archive, { marina, days: DAYS, since: "0000000000000000" })).toBe("invalid_since");
      // marina and days are checked first
      expect(await radiusChangesSince(tx, archive, { marina, days: 0, since: other.key })).toBe("invalid_days");
      expect(await radiusChangesSince(tx, archive, { marina: EAST.spot, days: DAYS, since: other.key })).toBe("marina_not_found");
    }));

  it("(f) `since` equal to the current key gives no changes and records a `changes` request", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const { marina, archive } = await setup(tx, { east: true });
      const current = await getRadiusPackage(tx, archive, { marina, days: DAYS, now: NOW });
      isRow(current);
      expect(await radiusChangesSince(tx, archive, { marina, days: DAYS, since: current.key, apiClientId: undefined })).toEqual({
        key: current.key,
        changes: [],
      });
      const requests = await tx.select().from(radiusPackageRequests).where(eq(radiusPackageRequests.radiusPackageId, current.id));
      expect(requests.map((r) => r.kind).sort()).toEqual(["changes", "package"]);
    }));
});
