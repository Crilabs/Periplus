import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { deliveredObjects, deliveries, geoObjects } from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import { withRollback } from "@/test/db";

/** drizzle wraps driver errors ("Failed query"); the Postgres message lives on `cause`. */
async function rejectionMessage(tx: Db, run: (tx: Db) => Promise<unknown>): Promise<string> {
  try {
    // savepoint, so the surrounding transaction survives the expected failure
    await tx.transaction(async (sp) => {
      await run(sp);
    });
  } catch (e) {
    const err = e as Error;
    return `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`;
  }
  throw new Error("expected promise to reject");
}

// Synthetic area outside the pilot box (23.0-23.75 E x 37.0-38.0 N), rolled back.
async function insertArea(tx: Db): Promise<string> {
  const [row] = await tx
    .insert(geoObjects)
    .values({ type: "area", origin: "manual", geom: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] }) })
    .returning({ id: geoObjects.id });
  return row!.id;
}

const deliveryValues = (areaId: string, patch: Partial<typeof deliveries.$inferInsert> = {}) => ({
  areaId,
  dataVersion: 1,
  schemaVersion: "1.0",
  generatedAt: new Date("2026-10-19T08:00:00Z"),
  status: "valid" as const,
  storagePrefix: `deliveries/${areaId}/1/`,
  objectCounts: { spots: 0 },
  validationReport: { checks: [] },
  changeXmin: sql`pg_snapshot_xmin(pg_current_snapshot())`,
  ...patch,
});

async function insertDelivery(tx: Db, areaId: string, patch: Partial<typeof deliveries.$inferInsert> = {}) {
  const [row] = await tx.insert(deliveries).values(deliveryValues(areaId, patch)).returning();
  return row!;
}

const objectValues = (
  areaId: string,
  deliveryId: string,
  patch: Partial<typeof deliveredObjects.$inferInsert> = {},
) => ({
  areaId,
  objectType: "spot" as const,
  publicId: "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z1",
  profileVersion: 1,
  contentHash: "h1",
  validFrom: "2026-10-19",
  firstDeliveryId: deliveryId,
  ...patch,
});

describe("deliveries and delivered objects", () => {
  it.each(["deliveries", "delivered_objects"])("%s rejects UPDATE and DELETE", async (table) => {
    await withRollback(async (tx) => {
      const areaId = await insertArea(tx);
      const delivery = await insertDelivery(tx, areaId);
      const [object] = await tx
        .insert(deliveredObjects)
        .values(objectValues(areaId, delivery.id))
        .returning({ id: deliveredObjects.id });
      const id = table === "deliveries" ? delivery.id : object!.id;

      const update = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`update ${sql.identifier(table)} set created_at = now() - interval '1 day' where id = ${id}`),
      );
      expect(update).toMatch(new RegExp(`${table} is append-only`));
      const del = await rejectionMessage(tx, (sp) => sp.execute(sql`delete from ${sql.identifier(table)} where id = ${id}`));
      expect(del).toMatch(new RegExp(`${table} is append-only`));
    });
  });

  it("a delivery records the defaults and the change-feed snapshot", async () => {
    await withRollback(async (tx) => {
      const areaId = await insertArea(tx);
      const row = await insertDelivery(tx, areaId, { fileHashes: undefined });
      expect(row.fileHashes).toEqual({});
      expect(row.changeXmin).toMatch(/^\d+$/);
      expect(row.createdAt).toBeInstanceOf(Date);
    });
  });

  it("a second valid delivery with the same data version for an area fails", async () => {
    await withRollback(async (tx) => {
      const areaId = await insertArea(tx);
      const otherAreaId = await insertArea(tx);
      const first = await insertDelivery(tx, areaId);
      const message = await rejectionMessage(tx, (sp) => insertDelivery(sp, areaId, { previousDeliveryId: first.id }));
      expect(message).toMatch(/deliveries_area_data_version_unique/);
      // Version 1 of another area and version 2 of the same area are fine; so are any number of versionless rows.
      await insertDelivery(tx, otherAreaId);
      await insertDelivery(tx, areaId, { dataVersion: 2, previousDeliveryId: first.id });
      await insertDelivery(tx, areaId, { dataVersion: null, status: "rejected" });
      await insertDelivery(tx, areaId, { dataVersion: null, status: "rejected" });
      await insertDelivery(tx, areaId, { dataVersion: null, status: "unchanged", storagePrefix: null });
    });
  });

  it("a rejected delivery must not carry a data version", async () => {
    await withRollback(async (tx) => {
      const areaId = await insertArea(tx);
      const rejected = await rejectionMessage(tx, (sp) => insertDelivery(sp, areaId, { status: "rejected" }));
      expect(rejected).toMatch(/deliveries_data_version_iff_valid/);
      const unchanged = await rejectionMessage(tx, (sp) =>
        insertDelivery(sp, areaId, { status: "unchanged", storagePrefix: null }),
      );
      expect(unchanged).toMatch(/deliveries_data_version_iff_valid/);
      const validWithout = await rejectionMessage(tx, (sp) => insertDelivery(sp, areaId, { dataVersion: null }));
      expect(validWithout).toMatch(/deliveries_data_version_iff_valid/);
      const zero = await rejectionMessage(tx, (sp) => insertDelivery(sp, areaId, { dataVersion: 0 }));
      expect(zero).toMatch(/deliveries_data_version_positive/);
    });
  });

  it("only an unchanged delivery has no storage prefix", async () => {
    await withRollback(async (tx) => {
      const areaId = await insertArea(tx);
      const valid = await rejectionMessage(tx, (sp) => insertDelivery(sp, areaId, { storagePrefix: null }));
      expect(valid).toMatch(/deliveries_storage_prefix_iff_stored/);
      const unchanged = await rejectionMessage(tx, (sp) =>
        insertDelivery(sp, areaId, { dataVersion: null, status: "unchanged" }),
      );
      expect(unchanged).toMatch(/deliveries_storage_prefix_iff_stored/);
    });
  });

  it("spot and highlight versions are unique per public id across areas, region versions per area", async () => {
    await withRollback(async (tx) => {
      const areaId = await insertArea(tx);
      const otherAreaId = await insertArea(tx);
      const delivery = await insertDelivery(tx, areaId);
      const other = await insertDelivery(tx, otherAreaId);
      await tx.insert(deliveredObjects).values(objectValues(areaId, delivery.id));

      // Ruling M6-P13: a spot moved to another area by a tile relabel keeps counting its versions.
      const spot = await rejectionMessage(tx, (sp) => sp.insert(deliveredObjects).values(objectValues(otherAreaId, other.id)));
      expect(spot).toMatch(/delivered_objects_public_version_unique/);
      await tx.insert(deliveredObjects).values(objectValues(otherAreaId, other.id, { profileVersion: 2, contentHash: "h2" }));

      const highlight = { objectType: "highlight" as const, publicId: "hl_01J9X4KQ3P2N1M0Z9K8J7H6G5F" };
      await tx.insert(deliveredObjects).values(objectValues(areaId, delivery.id, highlight));
      const hl = await rejectionMessage(tx, (sp) =>
        sp.insert(deliveredObjects).values(objectValues(otherAreaId, other.id, highlight)),
      );
      expect(hl).toMatch(/delivered_objects_public_version_unique/);

      // A region shared by two area packages has its own versions in each.
      const region = { objectType: "region" as const, publicId: "rg_01J9X4KZ0A1B2C3D4E5F6G7H8J" };
      await tx.insert(deliveredObjects).values(objectValues(areaId, delivery.id, region));
      await tx.insert(deliveredObjects).values(objectValues(otherAreaId, other.id, region));
      const rg = await rejectionMessage(tx, (sp) => sp.insert(deliveredObjects).values(objectValues(areaId, delivery.id, region)));
      expect(rg).toMatch(/delivered_objects_area_region_version_unique/);
    });
  });

  it("a removed object carries the content hash 'removed' and nothing else does", async () => {
    await withRollback(async (tx) => {
      const areaId = await insertArea(tx);
      const delivery = await insertDelivery(tx, areaId);
      const removedWithHash = await rejectionMessage(tx, (sp) =>
        sp.insert(deliveredObjects).values(objectValues(areaId, delivery.id, { removed: true })),
      );
      expect(removedWithHash).toMatch(/delivered_objects_removed_hash/);
      const hashWithoutRemoved = await rejectionMessage(tx, (sp) =>
        sp.insert(deliveredObjects).values(objectValues(areaId, delivery.id, { contentHash: "removed" })),
      );
      expect(hashWithoutRemoved).toMatch(/delivered_objects_removed_hash/);
      const version = await rejectionMessage(tx, (sp) =>
        sp.insert(deliveredObjects).values(objectValues(areaId, delivery.id, { profileVersion: 0 })),
      );
      expect(version).toMatch(/delivered_objects_profile_version_positive/);
      const [row] = await tx
        .insert(deliveredObjects)
        .values(objectValues(areaId, delivery.id, { removed: true, contentHash: "removed", profileVersion: 2 }))
        .returning();
      expect(row).toMatchObject({ removed: true, contentHash: "removed", geoObjectId: null });
    });
  });
});
