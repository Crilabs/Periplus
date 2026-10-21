import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { deliveredObjects, deliveries, geoNames, geoObjects, subdivisions } from "@/lib/db/schema";
import { newId, newPublicId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";
import { seedDeliverySubdivision } from "@/test/fixtures/delivery/subdivision";
import { memoryArchive } from "@/test/s3";
import { insertTestSubdivision } from "@/test/text";
import { buildDelivery, type DeliveryRow } from "../build";
import { changesSince, deliveryFiles, spotAsOf } from "../read";
import { serializeFile, sha256Hex } from "../serialize";

/*
 * `spotAsOf` and `changesSince` on hand-written delivery rows (rolled back): a spot that moved between subdivisions
 * (ruling M6-P13, NOTE of M6-D-R1) and a broken archive.
 */

type TestSubdivision = { id: string; publicId: string; key: string };

async function insertSubdivision(tx: Db, box: [number, number, number, number] = [21, 35, 21.1, 35.1]): Promise<TestSubdivision> {
  const key = `XT-${newId()}`;
  const { id } = await insertTestSubdivision(tx, key, box);
  const [row] = await tx.select({ publicId: subdivisions.publicId }).from(subdivisions).where(eq(subdivisions.id, id));
  return { id, publicId: row!.publicId, key };
}

/** A valid delivery of `subdivision` whose files are `files` (stored in `archive`); returns its id. */
async function insertDelivery(
  tx: Db,
  archive: Archive,
  subdivision: TestSubdivision,
  dataVersion: number,
  files: Record<string, unknown>,
): Promise<string> {
  const prefix = `deliveries/${subdivision.key}/${dataVersion}/`;
  const fileHashes: Record<string, { sha256: string; bytes: number }> = {};
  for (const [name, content] of Object.entries(files)) {
    const bytes = serializeFile(content);
    await archive.put(prefix + name, bytes, "application/json");
    fileHashes[name] = { sha256: sha256Hex(bytes), bytes: bytes.byteLength };
  }
  const [row] = await tx
    .insert(deliveries)
    .values({
      subdivisionId: subdivision.id,
      dataVersion,
      schemaVersion: "2.0",
      generatedAt: new Date("2040-06-01T08:00:00Z"),
      status: "valid",
      storagePrefix: prefix,
      fileHashes,
      objectCounts: {},
      validationReport: {},
      changeSnapshot: sql`pg_current_snapshot()`,
      changeXmin: sql`pg_snapshot_xmin(pg_current_snapshot())`,
    })
    .returning({ id: deliveries.id });
  return row!.id;
}

async function insertVersion(
  tx: Db,
  input: { subdivisionId: string; publicId: string; version: number; validFrom: string; deliveryId: string; removed?: boolean },
): Promise<void> {
  await tx.insert(deliveredObjects).values({
    subdivisionId: input.subdivisionId,
    objectType: "spot",
    publicId: input.publicId,
    profileVersion: input.version,
    contentHash: input.removed ? "removed" : `hash-${input.version}`,
    validFrom: input.validFrom,
    removed: input.removed ?? false,
    firstDeliveryId: input.deliveryId,
  });
}

describe("deliveryFiles", () => {
  it("lists the contract files in contract order, then the image files sorted; nothing else", () => {
    const a = "images/sp_01ARZ3NDEKTSV4RRFFQ69G5FAA-title.jpg";
    const a2 = "images/sp_01ARZ3NDEKTSV4RRFFQ69G5FAA-view-2.jpg";
    const b = "images/sp_01ARZ3NDEKTSV4RRFFQ69G5FAB-title.jpg";
    const hash = { sha256: "x", bytes: 1 };
    const row = {
      fileHashes: {
        [b]: hash,
        "spots.json": hash,
        "weather-points.json": hash,
        [a2]: hash,
        "manifest.json": hash,
        [a]: hash,
        "coast.geojson": hash,
        "regions.json": hash,
        "highlights.json": hash,
        // not a package file: a traversal and a stray key never become a link
        "../secret": hash,
        "images/notes.txt": hash,
      },
    } as unknown as DeliveryRow;
    expect(deliveryFiles(row)).toEqual(["manifest.json", "spots.json", "highlights.json", "regions.json", "coast.geojson", "weather-points.json", a, a2, b]);
    expect(deliveryFiles({ fileHashes: {} } as unknown as DeliveryRow)).toEqual([]);
  });
});

describe("spotAsOf", () => {
  it("a spot that moved to another subdivision is found although its old subdivision reports it removed", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const [west, east] = [await insertSubdivision(tx), await insertSubdivision(tx, [21.1, 35, 21.2, 35.1])];
      const id = newPublicId("sp");
      const spot = (v: number, area: string) => ({ id, profileVersion: v, name: `v${v} in ${area}` });
      // v1 in west, then east delivers it as v2, then west reports it removed as v3, then east removes it as v4
      const w1 = await insertDelivery(tx, archive, west, 1, { "spots.json": { spots: [spot(1, "west")] } });
      await insertVersion(tx, { subdivisionId: west.id, publicId: id, version: 1, validFrom: "2040-06-01", deliveryId: w1 });
      const e1 = await insertDelivery(tx, archive, east, 1, { "spots.json": { spots: [{ id: newPublicId("sp") }, spot(2, "east")] } });
      await insertVersion(tx, { subdivisionId: east.id, publicId: id, version: 2, validFrom: "2040-06-05", deliveryId: e1 });
      const w2 = await insertDelivery(tx, archive, west, 2, { "spots.json": { spots: [] } });
      await insertVersion(tx, { subdivisionId: west.id, publicId: id, version: 3, validFrom: "2040-06-06", deliveryId: w2, removed: true });

      expect(await spotAsOf(tx, archive, id, "2040-05-31")).toBeNull();
      expect(await spotAsOf(tx, archive, id, "2040-06-02")).toEqual({ spot: spot(1, "west"), dataVersion: 1, subdivision: west.publicId, deliveryId: w1 });
      expect(await spotAsOf(tx, archive, id, "2040-06-05")).toEqual({ spot: spot(2, "east"), dataVersion: 1, subdivision: east.publicId, deliveryId: e1 });
      expect(await spotAsOf(tx, archive, id, "2040-06-07")).toEqual({ spot: spot(2, "east"), dataVersion: 1, subdivision: east.publicId, deliveryId: e1 });
      expect(await spotAsOf(tx, archive, id)).toEqual({ spot: spot(2, "east"), dataVersion: 1, subdivision: east.publicId, deliveryId: e1 });

      const e2 = await insertDelivery(tx, archive, east, 2, { "spots.json": { spots: [] } });
      await insertVersion(tx, { subdivisionId: east.id, publicId: id, version: 4, validFrom: "2040-06-10", deliveryId: e2, removed: true });
      expect(await spotAsOf(tx, archive, id, "2040-06-09")).toEqual({ spot: spot(2, "east"), dataVersion: 1, subdivision: east.publicId, deliveryId: e1 });
      expect(await spotAsOf(tx, archive, id, "2040-06-10")).toBeNull();
      expect(await spotAsOf(tx, archive, id)).toBeNull();
    }));

  it("a spot whose place moved to another subdivision, through buildDelivery", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const build = (subdivisionId: string, date: string) =>
        buildDelivery(tx, archive, subdivisionId, { now: new Date(`${date}T08:00:00Z`), inCallerTransaction: true });
      const m = f.places.M.publicId!;
      expect(await build(f.subdivisionId, "2040-06-01")).toMatchObject({ status: "valid", dataVersion: 1 });

      // a neighbour over the east tile: the marina M is reassigned to its land (same `sp_` id)
      const [, s, e, n] = f.bbox;
      const second = await insertSubdivision(tx, [(f.bbox[0] + e) / 2, s, e, n]);
      const [region] = await tx.select({ id: subdivisions.geoObjectId }).from(subdivisions).where(eq(subdivisions.id, second.id));
      await tx.insert(geoNames).values({ geoObjectId: region!.id, name: "Ostteil", nameNormalized: "ostteil", language: "de", script: "latin", origin: "manual" });
      await tx.update(geoObjects).set({ subdivisionId: second.id }).where(eq(geoObjects.id, f.places.M.geoObjectId));
      expect(await build(second.id, "2040-06-05")).toMatchObject({ status: "valid", dataVersion: 1 });
      const moved = await spotAsOf(tx, archive, m, "2040-06-05");
      // the versions of a spot count across subdivisions: the new subdivision continues them
      expect(moved).toMatchObject({ subdivision: second.publicId, dataVersion: 1, spot: { id: m, profileVersion: 2, validFrom: "2040-06-05" } });
      expect(await spotAsOf(tx, archive, m, "2040-06-02")).toMatchObject({ subdivision: f.subdivisionPublicId, dataVersion: 1, spot: { profileVersion: 1 } });

      // the old subdivision rebuilds and reports M removed, with a higher version than the new subdivision's
      expect(await build(f.subdivisionId, "2040-06-08")).toMatchObject({ status: "valid", dataVersion: 2 });
      const removed = await tx
        .select({ version: deliveredObjects.profileVersion })
        .from(deliveredObjects)
        .where(and(eq(deliveredObjects.publicId, m), eq(deliveredObjects.removed, true)));
      expect(removed).toEqual([{ version: 3 }]);
      expect(await spotAsOf(tx, archive, m)).toEqual(moved);
      expect(await spotAsOf(tx, archive, m, "2040-06-09")).toEqual(moved);
    }));

  it("a spot missing from the spots.json of its delivery throws", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const subdivision = await insertSubdivision(tx);
      const id = newPublicId("sp");
      const d = await insertDelivery(tx, archive, subdivision, 1, { "spots.json": { spots: [] } });
      await insertVersion(tx, { subdivisionId: subdivision.id, publicId: id, version: 1, validFrom: "2040-06-01", deliveryId: d });
      await expect(spotAsOf(tx, archive, id)).rejects.toThrow(/not in spots.json/);
    }));
});

describe("changesSince", () => {
  it("reports not_found without a valid delivery and throws when a change file is missing", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const subdivision = await insertSubdivision(tx);
      expect(await changesSince(tx, archive, subdivision.id, 1)).toBe("not_found");
      await insertDelivery(tx, archive, subdivision, 1, { "spots.json": { spots: [] } });
      await insertDelivery(tx, archive, subdivision, 2, { "spots.json": { spots: [] } });
      expect(await changesSince(tx, archive, subdivision.id, 2)).toEqual({ dataVersion: 2, changes: [] });
      expect(await changesSince(tx, archive, subdivision.id, 3)).toBe("invalid_since");
      expect(await changesSince(tx, archive, subdivision.id, 0)).toBe("invalid_since");
      await expect(changesSince(tx, archive, subdivision.id, 1)).rejects.toThrow(/has no changes.json/);
    }));
});
