import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, places, tiles, type PlaceStatus } from "@/lib/db/schema";
import {
  addToComparisonSet,
  comparisonOverview,
  comparisonSetSize,
  listComparisonCandidates,
  removeFromComparisonSet,
} from "@/lib/domain/comparison";
import { newId } from "@/lib/domain/ids";
import { tileIdFor } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";

// Open sea outside the pilot box 23.0-23.75 E x 37.0-38.0 N, at a spot no other test uses.
const LON = 26.13;
const LAT = 33.37;
const TILE = tileIdFor(LON, LAT);
const BY = "admin@example.invalid";

async function insertArea(tx: Db): Promise<{ id: string; key: string }> {
  const key = `test-${newId()}`;
  const [o] = await tx
    .insert(geoObjects)
    .values({ type: "area", origin: "manual", configKey: key, geom: sql`${geomFromGeoJson({ type: "Point", coordinates: [LON, LAT] })}` })
    .returning({ id: geoObjects.id });
  return { id: o!.id, key };
}

async function insertTile(tx: Db, areaId: string | null) {
  await tx.insert(tiles).values({
    id: TILE,
    bbox: sql`ST_MakeEnvelope(26.0, 33.25, 26.25, 33.5, 4326)`,
    areaId,
  });
}

async function insertPlace(tx: Db, status: PlaceStatus, name: string): Promise<string> {
  const geom = sql`${geomFromGeoJson({ type: "Point", coordinates: [LON, LAT] })}`;
  const [o] = await tx.insert(geoObjects).values({ type: "bay", origin: "osm", geom }).returning({ id: geoObjects.id });
  await tx.insert(geoNames).values({
    geoObjectId: o!.id,
    name,
    nameNormalized: name.toLowerCase(),
    language: "de",
    script: "latin",
    origin: "osm",
    isPreferred: true,
  });
  const [p] = await tx
    .insert(places)
    .values({ geoObjectId: o!.id, kind: "anchorage", status, position: geom })
    .returning({ id: places.id });
  return p!.id;
}

describe("comparison set", () => {
  it("only confirmed places can be added", () =>
    withRollback(async (tx) => {
      const area = await insertArea(tx);
      await insertTile(tx, area.id);
      const candidate = await insertPlace(tx, "candidate", "Kandidat");
      const confirmed = await insertPlace(tx, "confirmed", "Bestaetigt");
      await expect(tx.transaction((t) => addToComparisonSet(t, candidate, area.key, BY))).rejects.toThrow();
      await addToComparisonSet(tx, confirmed, area.key, BY);
      expect(await comparisonSetSize(tx, area.key)).toBe(1);
    }));

  it("places outside the area cannot be added", () =>
    withRollback(async (tx) => {
      const area = await insertArea(tx);
      await insertTile(tx, null);
      const place = await insertPlace(tx, "confirmed", "Fremd");
      await expect(tx.transaction((t) => addToComparisonSet(t, place, area.key, BY))).rejects.toThrow();
    }));

  it("adding twice keeps one row", () =>
    withRollback(async (tx) => {
      const area = await insertArea(tx);
      await insertTile(tx, area.id);
      const place = await insertPlace(tx, "confirmed", "Doppelt");
      await addToComparisonSet(tx, place, area.key, BY);
      await addToComparisonSet(tx, place, area.key, "other@example.invalid");
      expect(await comparisonSetSize(tx, area.key)).toBe(1);
      const rows = await listComparisonCandidates(tx, area.key);
      expect(rows).toEqual([{ placeId: place, name: "Doppelt", kind: "anchorage", tileId: TILE, inSet: true }]);
      await removeFromComparisonSet(tx, place);
      expect(await comparisonSetSize(tx, area.key)).toBe(0);
      expect((await listComparisonCandidates(tx, area.key))[0]!.inSet).toBe(false);
    }));

  it("size counts per area", () =>
    withRollback(async (tx) => {
      const a = await insertArea(tx);
      const b = await insertArea(tx);
      await insertTile(tx, a.id);
      const place = await insertPlace(tx, "confirmed", "Eins");
      await addToComparisonSet(tx, place, a.key, BY);
      expect(await comparisonSetSize(tx, a.key)).toBe(1);
      expect(await comparisonSetSize(tx, b.key)).toBe(0);
      expect(await listComparisonCandidates(tx, b.key)).toEqual([]);
    }));

  it("comparison_set has no column for foreign values", () =>
    withRollback(async (tx) => {
      const res = await tx.execute(
        sql`select column_name from information_schema.columns where table_name = 'comparison_set' order by column_name`,
      );
      const names = (res.rows as { column_name: string }[]).map((r) => r.column_name);
      expect(names).toEqual(["added_at", "added_by", "area_id", "place_id", "subdivision_id"]);
    }));
});

describe("comparisonOverview", () => {
  it("is null for a configured area without an area object (no gazetteer run yet)", () =>
    withRollback(async (tx) => {
      expect(await comparisonOverview(tx, `not-created-${newId()}`)).toBeNull();
    }));

  it("lists the candidates and the set size of an existing area", () =>
    withRollback(async (tx) => {
      const area = await insertArea(tx);
      expect(await comparisonOverview(tx, area.key)).toEqual({ candidates: [], size: 0 });
      await insertTile(tx, area.id);
      const placeId = await insertPlace(tx, "confirmed", "Testbucht");
      await addToComparisonSet(tx, placeId, area.key, BY);
      expect(await comparisonOverview(tx, area.key)).toEqual({
        candidates: [{ placeId, name: "Testbucht", kind: "anchorage", tileId: TILE, inSet: true }],
        size: 1,
      });
    }));
});
