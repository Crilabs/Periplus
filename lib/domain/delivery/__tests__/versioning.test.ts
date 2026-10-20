import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { SpotBody } from "@/contract";
import { TEIL_B_EXAMPLE } from "@/contract/__tests__/fixtures";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { deliveredObjects, deliveries, geoObjects } from "@/lib/db/schema";
import { canonicalJson } from "@/lib/domain/facts/schema";
import { withRollback } from "@/test/db";
import { insertTestSubdivision } from "@/test/text";
import { assignVersions, contentHash, latestDelivered, type DeliveredEntry, type ObjectDraft } from "../versioning";

const BODY: SpotBody = Object.fromEntries(
  Object.entries(TEIL_B_EXAMPLE).filter(([k]) => k !== "profileVersion" && k !== "validFrom"),
) as SpotBody;
const SP = BODY.id;
const SP2 = "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z2";
const GEO = "01a15602-0000-7000-8000-000000000001";
const draft = (body: SpotBody = BODY): ObjectDraft => ({ type: "spot", id: body.id, geoObjectId: GEO, body });
const entry = (patch: Partial<DeliveredEntry> = {}): DeliveredEntry => ({
  type: "spot",
  geoObjectId: GEO,
  profileVersion: 1,
  contentHash: contentHash(BODY),
  validFrom: "2026-10-01",
  removed: false,
  ...patch,
});
const withSector = (n: number): SpotBody => ({ ...BODY, shelter: { ...BODY.shelter, sectors: { ...BODY.shelter.sectors, N: n } } });

describe("contentHash", () => {
  it("is sha256 hex of the canonical JSON, independent of key order", () => {
    const reordered = JSON.parse(canonicalJson(BODY)) as SpotBody;
    expect(contentHash(BODY)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash(reordered)).toBe(contentHash(BODY));
    expect(contentHash(withSector(0.5))).not.toBe(contentHash(BODY));
  });
});

describe("assignVersions", () => {
  it("generatedAt and validFrom do not enter the content hash", () => {
    // the body carries neither: the envelope's generatedAt and the version fields live outside it
    expect(Object.keys(BODY)).not.toContain("validFrom");
    expect(Object.keys(BODY)).not.toContain("profileVersion");
    const latest = new Map([[SP, entry({ profileVersion: 3, validFrom: "2026-10-01" })]]);
    const { objects, removed } = assignVersions([draft(structuredClone(BODY))], latest, "2026-10-20");
    expect(objects[0]).toMatchObject({ profileVersion: 3, validFrom: "2026-10-01", status: "same", contentHash: contentHash(BODY) });
    expect(removed).toEqual([]);
  });

  it("a changed sector bumps the version and sets validFrom to today", () => {
    const latest = new Map([[SP, entry({ profileVersion: 3 })]]);
    const { objects } = assignVersions([draft(withSector(0.3))], latest, "2026-10-20");
    expect(objects[0]).toMatchObject({ profileVersion: 4, validFrom: "2026-10-20", status: "updated" });
  });

  it("a new object starts at version 1", () => {
    const { objects } = assignVersions([draft()], new Map(), "2026-10-20");
    expect(objects[0]).toMatchObject({ profileVersion: 1, validFrom: "2026-10-20", status: "created" });
  });

  it("a removed object gets event removed and the next version", () => {
    const latest = new Map([
      [SP, entry({ profileVersion: 2 })],
      [SP2, entry({ profileVersion: 1, removed: true, contentHash: "removed" })],
    ]);
    const { objects, removed } = assignVersions([], latest, "2026-10-20");
    expect(objects).toEqual([]);
    // an object removed before is not removed again
    expect(removed).toEqual([{ type: "spot", id: SP, geoObjectId: GEO, profileVersion: 3 }]);
  });

  it("a reappearing object continues the version", () => {
    // 1 → 2 removed → 3 created
    const latest = new Map([[SP, entry({ profileVersion: 2, removed: true, contentHash: "removed" })]]);
    const { objects } = assignVersions([draft()], latest, "2026-10-20");
    expect(objects[0]).toMatchObject({ profileVersion: 3, validFrom: "2026-10-20", status: "created" });
  });

  it("the next version follows the highest one of the public id, also from another subdivision (ruling M6-P13)", () => {
    const latest = new Map([[SP, entry({ profileVersion: 2, maxVersion: 5 })]]);
    expect(assignVersions([draft(withSector(0.3))], latest, "2026-10-20").objects[0]).toMatchObject({ profileVersion: 6, status: "updated" });
    expect(assignVersions([draft()], latest, "2026-10-20").objects[0]).toMatchObject({ profileVersion: 2, status: "same" });
    expect(assignVersions([], latest, "2026-10-20").removed[0]).toMatchObject({ profileVersion: 6 });
  });

  it("rejects a duplicate draft", () => {
    expect(() => assignVersions([draft(), draft()], new Map(), "2026-10-20")).toThrow(/duplicate/);
  });
});

/** A pilot area of contract 1.0 (deliveries by `area_id`). */
async function insertArea(tx: Db): Promise<string> {
  const [row] = await tx
    .insert(geoObjects)
    .values({ type: "area", origin: "manual", geom: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] }) })
    .returning({ id: geoObjects.id });
  return row!.id;
}

async function insertDelivery(tx: Db, scope: { subdivisionId: string } | { areaId: string }, dataVersion: number): Promise<string> {
  const [row] = await tx
    .insert(deliveries)
    .values({
      ...scope,
      dataVersion,
      schemaVersion: "subdivisionId" in scope ? "2.0" : "1.0",
      generatedAt: new Date("2026-10-19T08:00:00Z"),
      status: "valid",
      storagePrefix: `deliveries/${Object.values(scope)[0]}/${dataVersion}/`,
      objectCounts: {},
      validationReport: {},
      changeSnapshot: sql`pg_current_snapshot()`,
      changeXmin: sql`pg_snapshot_xmin(pg_current_snapshot())`,
    })
    .returning({ id: deliveries.id });
  return row!.id;
}

describe("latestDelivered", () => {
  it("returns the highest version per public id; spot versions span subdivisions and pilot packages, region versions stay per subdivision", async () => {
    await withRollback(async (tx) => {
      const x = (await insertTestSubdivision(tx, "XT-VX", [20.0, 34.0, 20.25, 34.25])).id;
      const y = (await insertTestSubdivision(tx, "XT-VY", [20.25, 34.0, 20.5, 34.25])).id;
      const pilot = await insertArea(tx);
      const dx = await insertDelivery(tx, { subdivisionId: x }, 1);
      const dy = await insertDelivery(tx, { subdivisionId: y }, 1);
      const dp = await insertDelivery(tx, { areaId: pilot }, 1);
      const RG = "rg_01J9X4KZ0A1B2C3D4E5F6G7H8J";
      const SP3 = "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z3";
      const row = (subdivisionId: string, firstDeliveryId: string, patch: Partial<typeof deliveredObjects.$inferInsert>) => ({
        subdivisionId,
        firstDeliveryId,
        objectType: "spot" as const,
        publicId: SP,
        profileVersion: 1,
        contentHash: "h1",
        validFrom: "2026-10-01",
        ...patch,
      });
      await tx.insert(deliveredObjects).values([
        row(x, dx, {}),
        row(x, dx, { profileVersion: 2, contentHash: "h2", validFrom: "2026-10-10" }),
        row(x, dx, { publicId: SP2, profileVersion: 1 }),
        row(x, dx, { publicId: SP2, profileVersion: 2, contentHash: "removed", removed: true }),
        // a spot that moved from y to x keeps counting on: x delivered version 4 after y's 3
        row(y, dy, { publicId: SP3, profileVersion: 3, contentHash: "h3" }),
        row(x, dx, { publicId: SP3, profileVersion: 4, contentHash: "h4" }),
        // only in y: removed for x, with its version
        row(y, dy, { publicId: "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z4", profileVersion: 7, contentHash: "h7" }),
        // delivered only by a pilot package of contract 1.0: removed for x, its version continues
        { ...row(x, dp, { publicId: "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z5", profileVersion: 3, contentHash: "p3" }), subdivisionId: null, areaId: pilot },
        // regions count per subdivision
        row(x, dx, { objectType: "region", publicId: RG, profileVersion: 1, contentHash: "r1" }),
        row(y, dy, { objectType: "region", publicId: RG, profileVersion: 1, contentHash: "ry1" }),
        row(y, dy, { objectType: "region", publicId: RG, profileVersion: 2, contentHash: "ry2" }),
      ]);
      const latest = await latestDelivered(tx, x);
      expect(latest.get(SP)).toEqual({ type: "spot", geoObjectId: null, profileVersion: 2, contentHash: "h2", validFrom: "2026-10-10", removed: false, maxVersion: 2 });
      expect(latest.get(SP2)).toMatchObject({ profileVersion: 2, removed: true, maxVersion: 2 });
      expect(latest.get(SP3)).toMatchObject({ profileVersion: 4, contentHash: "h4", removed: false, maxVersion: 4 });
      expect(latest.get("sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z4")).toMatchObject({ profileVersion: 7, removed: true, maxVersion: 7 });
      expect(latest.get("sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z5")).toMatchObject({ profileVersion: 3, removed: true, maxVersion: 3 });
      expect(latest.get(RG)).toMatchObject({ type: "region", profileVersion: 1, contentHash: "r1", maxVersion: 1 });

      // y: SP3 was taken over by x — y removes it once, with the version after x's (no restart, no collision)
      const fromY = await latestDelivered(tx, y);
      expect(fromY.get(SP3)).toMatchObject({ profileVersion: 3, removed: false, maxVersion: 4 });
      expect(fromY.get(RG)).toMatchObject({ profileVersion: 2, contentHash: "ry2", maxVersion: 2 });
      const { removed } = assignVersions([], new Map([[SP3, fromY.get(SP3)!]]), "2026-10-20");
      expect(removed).toEqual([{ type: "spot", id: SP3, geoObjectId: null, profileVersion: 5 }]);
    });
  });
});
