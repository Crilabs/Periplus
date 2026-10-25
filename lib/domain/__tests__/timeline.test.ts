import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, profiles } from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import { latestProfile, profileAsOf } from "@/lib/domain/timeline";
import { withRollback } from "@/test/db";

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
      // valid_from never goes back per object (trigger); versions within a day arrive out of order and the higher wins.
      const id = await insertProfiles(tx, [
        [1, "2026-03-01"],
        [3, "2026-06-01"],
        [2, "2026-06-01"],
        [4, "2026-09-01"],
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
