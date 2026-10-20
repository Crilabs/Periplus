import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { deliveredObjects, deliveries, geoNames, geoObjects, tiles } from "@/lib/db/schema";
import { newId, newPublicId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";
import { seedDeliveryArea } from "@/test/fixtures/delivery/area";
import { memoryArchive } from "@/test/s3";
import { buildDelivery } from "../build";
import { changesSince, spotAsOf } from "../read";
import { serializeFile, sha256Hex } from "../serialize";

/*
 * `spotAsOf` and `changesSince` on hand-written delivery rows (rolled back): a spot that moved between areas (ruling
 * M6-P13, NOTE of M6-D-R1) and a broken archive.
 */

async function insertArea(tx: Db): Promise<{ id: string; publicId: string }> {
  const publicId = newPublicId("ar");
  const [row] = await tx
    .insert(geoObjects)
    .values({
      type: "area",
      origin: "manual",
      publicId,
      geom: geomFromGeoJson({ type: "Polygon", coordinates: [[[21, 35], [21.1, 35], [21.1, 35.1], [21, 35.1], [21, 35]]] }),
    })
    .returning({ id: geoObjects.id });
  return { id: row!.id, publicId };
}

/** A valid delivery of `area` whose files are `files` (stored in `archive`); returns its id. */
async function insertDelivery(
  tx: Db,
  archive: Archive,
  area: { id: string; publicId: string },
  dataVersion: number,
  files: Record<string, unknown>,
): Promise<string> {
  const prefix = `deliveries/${area.publicId}/${dataVersion}/`;
  const fileHashes: Record<string, { sha256: string; bytes: number }> = {};
  for (const [name, content] of Object.entries(files)) {
    const bytes = serializeFile(content);
    await archive.put(prefix + name, bytes, "application/json");
    fileHashes[name] = { sha256: sha256Hex(bytes), bytes: bytes.byteLength };
  }
  const [row] = await tx
    .insert(deliveries)
    .values({
      areaId: area.id,
      dataVersion,
      schemaVersion: "1.0",
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
  input: { areaId: string; publicId: string; version: number; validFrom: string; deliveryId: string; removed?: boolean },
): Promise<void> {
  await tx.insert(deliveredObjects).values({
    areaId: input.areaId,
    objectType: "spot",
    publicId: input.publicId,
    profileVersion: input.version,
    contentHash: input.removed ? "removed" : `hash-${input.version}`,
    validFrom: input.validFrom,
    removed: input.removed ?? false,
    firstDeliveryId: input.deliveryId,
  });
}

describe("spotAsOf", () => {
  it("a spot that moved to another area is found although its old area reports it removed", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const [west, east] = [await insertArea(tx), await insertArea(tx)];
      const id = newPublicId("sp");
      const spot = (v: number, area: string) => ({ id, profileVersion: v, name: `v${v} in ${area}` });
      // v1 in west, then east delivers it as v2, then west reports it removed as v3, then east removes it as v4
      const w1 = await insertDelivery(tx, archive, west, 1, { "spots.json": { spots: [spot(1, "west")] } });
      await insertVersion(tx, { areaId: west.id, publicId: id, version: 1, validFrom: "2040-06-01", deliveryId: w1 });
      const e1 = await insertDelivery(tx, archive, east, 1, { "spots.json": { spots: [{ id: newPublicId("sp") }, spot(2, "east")] } });
      await insertVersion(tx, { areaId: east.id, publicId: id, version: 2, validFrom: "2040-06-05", deliveryId: e1 });
      const w2 = await insertDelivery(tx, archive, west, 2, { "spots.json": { spots: [] } });
      await insertVersion(tx, { areaId: west.id, publicId: id, version: 3, validFrom: "2040-06-06", deliveryId: w2, removed: true });

      expect(await spotAsOf(tx, archive, id, "2040-05-31")).toBeNull();
      expect(await spotAsOf(tx, archive, id, "2040-06-02")).toEqual({ spot: spot(1, "west"), dataVersion: 1, area: west.publicId, deliveryId: w1 });
      expect(await spotAsOf(tx, archive, id, "2040-06-05")).toEqual({ spot: spot(2, "east"), dataVersion: 1, area: east.publicId, deliveryId: e1 });
      expect(await spotAsOf(tx, archive, id, "2040-06-07")).toEqual({ spot: spot(2, "east"), dataVersion: 1, area: east.publicId, deliveryId: e1 });
      expect(await spotAsOf(tx, archive, id)).toEqual({ spot: spot(2, "east"), dataVersion: 1, area: east.publicId, deliveryId: e1 });

      const e2 = await insertDelivery(tx, archive, east, 2, { "spots.json": { spots: [] } });
      await insertVersion(tx, { areaId: east.id, publicId: id, version: 4, validFrom: "2040-06-10", deliveryId: e2, removed: true });
      expect(await spotAsOf(tx, archive, id, "2040-06-09")).toEqual({ spot: spot(2, "east"), dataVersion: 1, area: east.publicId, deliveryId: e1 });
      expect(await spotAsOf(tx, archive, id, "2040-06-10")).toBeNull();
      expect(await spotAsOf(tx, archive, id)).toBeNull();
    }));

  it("a spot moved to another area by a tile relabel, through buildDelivery", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      const build = (areaId: string, date: string) => buildDelivery(tx, archive, areaId, { now: new Date(`${date}T08:00:00Z`), inCallerTransaction: true });
      const m = f.places.M.publicId!;
      expect(await build(f.areaId, "2040-06-01")).toMatchObject({ status: "valid", dataVersion: 1 });

      // a second area over the same water takes over the east tile, and with it the marina M
      const [w, s, e, n] = f.bbox;
      const second = newPublicId("ar");
      const [row] = await tx
        .insert(geoObjects)
        .values({ type: "area", origin: "manual", publicId: second, configKey: `moved-${newId()}`, geom: geomFromGeoJson({ type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }) })
        .returning({ id: geoObjects.id });
      await tx.insert(geoNames).values({ geoObjectId: row!.id, name: "Ostrevier", nameNormalized: "ostrevier", language: "de", script: "latin", origin: "manual" });
      await tx.update(tiles).set({ areaId: row!.id }).where(eq(tiles.id, f.tileIds[1]));
      expect(await build(row!.id, "2040-06-05")).toMatchObject({ status: "valid", dataVersion: 1 });
      const moved = await spotAsOf(tx, archive, m, "2040-06-05");
      // the versions of a spot count across areas: the new area continues them
      expect(moved).toMatchObject({ area: second, dataVersion: 1, spot: { id: m, profileVersion: 2, validFrom: "2040-06-05" } });
      expect(await spotAsOf(tx, archive, m, "2040-06-02")).toMatchObject({ area: f.areaPublicId, dataVersion: 1, spot: { profileVersion: 1 } });

      // the old area rebuilds and reports M removed, with a higher version than the new area's
      expect(await build(f.areaId, "2040-06-08")).toMatchObject({ status: "valid", dataVersion: 2 });
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
      const area = await insertArea(tx);
      const id = newPublicId("sp");
      const d = await insertDelivery(tx, archive, area, 1, { "spots.json": { spots: [] } });
      await insertVersion(tx, { areaId: area.id, publicId: id, version: 1, validFrom: "2040-06-01", deliveryId: d });
      await expect(spotAsOf(tx, archive, id)).rejects.toThrow(/not in spots.json/);
    }));
});

describe("changesSince", () => {
  it("reports not_found without a valid delivery and throws when a change file is missing", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const area = await insertArea(tx);
      expect(await changesSince(tx, archive, area.id, 1)).toBe("not_found");
      await insertDelivery(tx, archive, area, 1, { "spots.json": { spots: [] } });
      await insertDelivery(tx, archive, area, 2, { "spots.json": { spots: [] } });
      expect(await changesSince(tx, archive, area.id, 2)).toEqual({ dataVersion: 2, changes: [] });
      expect(await changesSince(tx, archive, area.id, 3)).toBe("invalid_since");
      expect(await changesSince(tx, archive, area.id, 0)).toBe("invalid_since");
      await expect(changesSince(tx, archive, area.id, 1)).rejects.toThrow(/has no changes.json/);
    }));
});
