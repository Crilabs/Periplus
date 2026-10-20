import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { comparisonSet, geoObjects, tiles } from "@/lib/db/schema";
import { compareSnapshots, migrateSubdivisions, snapshotPilot } from "@/lib/domain/subdivisions/migration";
import { withRollback } from "@/test/db";
import { seedDeliverySubdivision } from "@/test/fixtures/delivery/subdivision";
import { parseArgs } from "../check-subdivision-migration";
import { parseArgs as parseMigrateArgs } from "../migrate-subdivisions";

/*
 * The pilot migration (spec 14 „Umstellung“) on the delivery fixture in the state of contract 1.0: its two tiles carry
 * the sailing area (`tiles.area_id`, the pilot tiles), its objects have no subdivision, the archipelago hangs below the
 * area, and a comparison set entry knows no subdivision.
 */

describe("migrateSubdivisions", () => {
  it("snapshot, migrate, snapshot: the pilot is unchanged; a second migration changes nothing", () =>
    withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const objectIds = [f.islandId, f.archipelagoId, f.capeId, f.poiId, ...Object.values(f.places).map((p) => p.geoObjectId)];
      await tx.update(tiles).set({ areaId: f.areaId }).where(inArray(tiles.id, f.tileIds));
      await tx.update(geoObjects).set({ subdivisionId: null }).where(inArray(geoObjects.id, objectIds));
      await tx.update(geoObjects).set({ parentId: f.areaId }).where(eq(geoObjects.id, f.archipelagoId));
      await tx.insert(comparisonSet).values({ placeId: f.places.A.placeId, areaId: f.areaId, addedBy: "test" });

      const before = await snapshotPilot(tx);
      expect(before.tiles.map((t) => t.tileId)).toEqual(f.tileIds);
      expect(before.tiles[0]!.places.length).toBeGreaterThan(0);
      expect(before.tiles[0]!.factIds.length).toBeGreaterThan(0);

      const first = await migrateSubdivisions(tx);
      expect(first.objects).toBeGreaterThanOrEqual(objectIds.length - 1);
      expect(first.comparison).toBe(1);
      const assigned = await tx.select({ id: geoObjects.id, subdivisionId: geoObjects.subdivisionId }).from(geoObjects).where(inArray(geoObjects.id, objectIds));
      // O lies in the third tile, outside the subdivision's land box but nearest to it: every object has the subdivision
      expect(assigned.filter((o) => o.id !== f.places.O.geoObjectId).every((o) => o.subdivisionId === f.subdivisionId)).toBe(true);
      const [archipelago] = await tx.select({ parentId: geoObjects.parentId }).from(geoObjects).where(eq(geoObjects.id, f.archipelagoId));
      expect(archipelago!.parentId).not.toBe(f.areaId);
      const [entry] = await tx.select().from(comparisonSet).where(eq(comparisonSet.placeId, f.places.A.placeId));
      expect(entry!.subdivisionId).toBe(f.subdivisionId);

      const after = await snapshotPilot(tx);
      expect(compareSnapshots(before, after)).toEqual([]);

      const second = await migrateSubdivisions(tx);
      expect(second).toMatchObject({ objects: 0, seas: 0, parents: 0, comparison: 0, seabed: 0 });
      expect(compareSnapshots(before, await snapshotPilot(tx))).toEqual([]);
    }));

  it("compareSnapshots names a lost fact and a changed profile version", () => {
    const tile = { tileId: "q025:1:1", places: [{ id: "p", publicId: "sp_1", status: "confirmed" }], factIds: ["f1", "f2"], profileVersions: ["g:1"] };
    const before = { takenAt: "x", tiles: [tile] };
    const after = { takenAt: "y", tiles: [{ ...tile, factIds: ["f1"], profileVersions: ["g:2"] }] };
    expect(compareSnapshots(before, after)).toEqual([
      "Kachel q025:1:1: Facts fehlen nachher: f2",
      "Kachel q025:1:1: Profilversionen fehlen nachher: g:1",
      "Kachel q025:1:1: Profilversionen neu: g:2",
    ]);
  });

  it("the scripts take their arguments", () => {
    expect(parseArgs(["--before", "a.json", "--after", "b.json"])).toEqual({ before: "a.json", after: "b.json" });
    expect(() => parseArgs(["--before", "a.json"])).toThrow(/usage/);
    expect(parseMigrateArgs(["snapshot", "--out", "a.json"])).toEqual({ command: "snapshot", out: "a.json" });
    expect(parseMigrateArgs(["migrate"])).toEqual({ command: "migrate" });
    expect(() => parseMigrateArgs(["migrate", "--out", "x"])).toThrow(/usage/);
  });
});

