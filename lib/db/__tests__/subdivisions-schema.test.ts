import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, runs, subdivisions } from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import { newPublicId } from "@/lib/domain/ids";
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

// Synthetic geometry outside the pilot box (23.0-23.75 E x 37.0-38.0 N), rolled back.
const multiPolygon = geomFromGeoJson({
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [21.0, 35.0],
        [21.5, 35.0],
        [21.5, 35.5],
        [21.0, 35.5],
        [21.0, 35.0],
      ],
    ],
  ],
});

async function insertSubdivision(tx: Db, patch: Partial<typeof subdivisions.$inferInsert> = {}) {
  const [region] = await tx
    .insert(geoObjects)
    .values({ type: "admin_region", origin: "manual", geom: multiPolygon })
    .returning({ id: geoObjects.id });
  const [row] = await tx
    .insert(subdivisions)
    .values({
      publicId: newPublicId("sd"),
      key: "gr-test",
      country: "GR",
      geoObjectId: region!.id,
      geom: multiPolygon,
      ...patch,
    })
    .returning({ id: subdivisions.id });
  return row!.id;
}

describe("subdivisions schema", () => {
  it("can be updated and deleted (no delete guard, no history since N6)", async () => {
    await withRollback(async (tx) => {
      const id = await insertSubdivision(tx);
      await tx.update(subdivisions).set({ status: "excluded", statusReason: "test" }).where(eq(subdivisions.id, id));
      await tx.delete(subdivisions).where(eq(subdivisions.id, id));
    });
  });

  it("public_id must start with sd_", async () => {
    await withRollback(async (tx) => {
      const message = await rejectionMessage(tx, (sp) => insertSubdivision(sp, { publicId: "sdX01" }));
      expect(message).toContain("subdivisions_public_id_prefix");
      const ok = await insertSubdivision(tx, { key: "gr-ok" });
      expect(ok).toBeTruthy();
    });
  });

  it("two valid rows cannot share a key", async () => {
    await withRollback(async (tx) => {
      await insertSubdivision(tx);
      const message = await rejectionMessage(tx, (sp) => insertSubdivision(sp));
      expect(message).toContain("subdivisions_key_valid_unique");
    });
  });

  it("geo_objects accepts types country and admin_region with public_id null", async () => {
    await withRollback(async (tx) => {
      const rows = await tx
        .insert(geoObjects)
        .values([
          { type: "country", origin: "manual", geom: multiPolygon },
          { type: "admin_region", origin: "marine_regions", geom: multiPolygon, adminLevel: 4 },
        ])
        .returning({ type: geoObjects.type, publicId: geoObjects.publicId });
      expect(rows.map((r) => r.type)).toEqual(["country", "admin_region"]);
      expect(rows.every((r) => r.publicId === null)).toBe(true);
    });
  });

  it("runs accept scope_type subdivision", async () => {
    await withRollback(async (tx) => {
      const [run] = await tx
        .insert(runs)
        .values({ kind: "full", scopeType: "subdivision", scopeId: "gr-test", triggeredBy: "test" })
        .returning({ scopeType: runs.scopeType });
      expect(run!.scopeType).toBe("subdivision");
    });
  });
});
