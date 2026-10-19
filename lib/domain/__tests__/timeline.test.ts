import { and, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, profiles } from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import { latestProfile, profileAsOf, validAt } from "@/lib/domain/timeline";
import { testDb, withRollback } from "@/test/db";

describe("validAt", () => {
  it("excludes rows that ended on the date and includes rows starting on it", async () => {
    const db = testDb();
    const geom = geomFromGeoJson({ type: "Point", coordinates: [23.4, 37.4] });
    const rows = await db
      .insert(geoObjects)
      .values([
        { type: "cape", origin: "manual", geom, validFrom: "2026-01-01", validTo: "2026-06-01" }, // ended on the date
        { type: "cape", origin: "manual", geom, validFrom: "2026-06-01" }, // starts on the date
        { type: "cape", origin: "manual", geom, validFrom: "2026-01-01", validTo: "2026-06-02" }, // ends after it
        { type: "cape", origin: "manual", geom, validFrom: "2026-06-02" }, // starts after it
      ])
      .returning({ id: geoObjects.id });
    const ids = rows.map((r) => r.id);

    const valid = await db
      .select({ id: geoObjects.id })
      .from(geoObjects)
      .where(and(inArray(geoObjects.id, ids), validAt(geoObjects, "2026-06-01")));

    expect(valid.map((r) => r.id).sort()).toEqual([ids[1], ids[2]].sort());
  });

  it("defaults to the current date", async () => {
    const db = testDb();
    const geom = geomFromGeoJson({ type: "Point", coordinates: [23.4, 37.4] });
    const rows = await db
      .insert(geoObjects)
      .values([
        { type: "cape", origin: "manual", geom }, // valid from today
        { type: "cape", origin: "manual", geom, validFrom: "2000-01-01", validTo: "2000-01-02" },
      ])
      .returning({ id: geoObjects.id });

    const valid = await db
      .select({ id: geoObjects.id })
      .from(geoObjects)
      .where(and(inArray(geoObjects.id, rows.map((r) => r.id)), validAt(geoObjects)));

    expect(valid.map((r) => r.id)).toEqual([rows[0]!.id]);
  });
});

// Synthetic data outside the pilot box (23.0-23.75 E x 37.0-38.0 N).
async function insertProfiles(tx: Db, versions: Array<[number, string]>): Promise<string> {
  const [geo] = await tx
    .insert(geoObjects)
    .values({ type: "bay", origin: "osm", geom: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] }) })
    .returning({ id: geoObjects.id });
  const id = geo!.id;
  if (versions.length === 0) return id;
  await tx.insert(profiles).values(
    versions.map(([version, validFrom]) => ({
      geoObjectId: id,
      version,
      validFrom,
      attributes: { "shelter.N": version / 10 },
      provenance: {},
      sourcesCount: version,
      documentsCount: version + 1,
      confidence: 0.5,
      contentHash: `h${version}`,
      factSchemaVersion: "v2",
      rulesVersion: "v1",
    })),
  );
  return id;
}

describe("profileAsOf", () => {
  it("profileAsOf picks the largest valid_from on or before the date", () =>
    withRollback(async (tx) => {
      // Inserted out of order: the read must not depend on insertion order.
      const id = await insertProfiles(tx, [
        [3, "2026-06-01"],
        [1, "2026-03-01"],
        [4, "2026-09-01"],
        [2, "2026-06-01"],
      ]);
      expect(await profileAsOf(tx, id, "2026-02-28")).toBeNull();
      expect((await profileAsOf(tx, id, "2026-03-01"))!.version).toBe(1);
      expect((await profileAsOf(tx, id, "2026-05-31"))!.version).toBe(1);
      expect((await profileAsOf(tx, id, "2026-06-15"))!.version).toBe(3);
      expect((await profileAsOf(tx, id, "2027-01-01"))!.version).toBe(4);
      expect((await latestProfile(tx, id))!.version).toBe(4);
    }));

  it("returns the stored snapshot", () =>
    withRollback(async (tx) => {
      const id = await insertProfiles(tx, [[1, "2026-03-01"]]);
      expect(await profileAsOf(tx, id, "2026-03-01")).toEqual({
        version: 1,
        validFrom: "2026-03-01",
        attributes: { "shelter.N": 0.1 },
        provenance: {},
        conflicts: [],
        gaps: [],
        sourcesCount: 1,
        documentsCount: 2,
        confidence: 0.5,
        contentHash: "h1",
        rulesVersion: "v1",
        factSchemaVersion: "v2",
      });
    }));

  it("an object without profiles has none", () =>
    withRollback(async (tx) => {
      const id = await insertProfiles(tx, []);
      expect(await latestProfile(tx, id)).toBeNull();
      expect(await profileAsOf(tx, id, "2026-10-19")).toBeNull();
    }));
});
