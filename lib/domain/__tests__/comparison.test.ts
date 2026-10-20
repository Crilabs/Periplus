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
import { insertTestSubdivision } from "@/test/text";

// Open sea outside the pilot box 23.0-23.75 E x 37.0-38.0 N, at a spot no other test uses.
const LON = 26.13;
const LAT = 33.37;
const TILE = tileIdFor(LON, LAT);
const BY = "admin@example.invalid";

async function insertSubdivision(tx: Db): Promise<{ id: string; key: string }> {
  const key = `XT-${newId()}`;
  const { id } = await insertTestSubdivision(tx, key, [25.9, 33.1, 26.4, 33.6]);
  return { id, key };
}

/** The tile of the places, labelled with `subdivisionId` (a label only: it decides no membership). */
async function insertTile(tx: Db, subdivisionId: string | null) {
  await tx.insert(tiles).values({
    id: TILE,
    bbox: sql`ST_MakeEnvelope(26.0, 33.25, 26.25, 33.5, 4326)`,
    subdivisionId,
  });
}

/** A place with its geo object, which belongs to `subdivisionId` (nearest land) or to none. */
async function insertPlace(tx: Db, status: PlaceStatus, name: string, subdivisionId: string | null): Promise<string> {
  const geom = sql`${geomFromGeoJson({ type: "Point", coordinates: [LON, LAT] })}`;
  const [o] = await tx.insert(geoObjects).values({ type: "bay", origin: "osm", geom, subdivisionId }).returning({ id: geoObjects.id });
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
    .values({ geoObjectId: o!.id, kind: "anchorage", status, position: geom, tileId: TILE })
    .returning({ id: places.id });
  return p!.id;
}

describe("comparison set", () => {
  it("only confirmed places can be added", () =>
    withRollback(async (tx) => {
      const sub = await insertSubdivision(tx);
      await insertTile(tx, sub.id);
      const candidate = await insertPlace(tx, "candidate", "Kandidat", sub.id);
      const confirmed = await insertPlace(tx, "confirmed", "Bestaetigt", sub.id);
      await expect(tx.transaction((t) => addToComparisonSet(t, candidate, sub.key, BY))).rejects.toThrow();
      await addToComparisonSet(tx, confirmed, sub.key, BY);
      expect(await comparisonSetSize(tx, sub.key)).toBe(1);
    }));

  it("places of another subdivision cannot be added, whatever their tile's label says", () =>
    withRollback(async (tx) => {
      const sub = await insertSubdivision(tx);
      const neighbour = await insertSubdivision(tx);
      // the tile carries the label of `sub`, the place's land is the neighbour's (a Kastellorizo-style place)
      await insertTile(tx, sub.id);
      const foreign = await insertPlace(tx, "confirmed", "Fremd", neighbour.id);
      const nobody = await insertPlace(tx, "confirmed", "Ohne Landesteil", null);
      await expect(tx.transaction((t) => addToComparisonSet(t, foreign, sub.key, BY))).rejects.toThrow();
      await expect(tx.transaction((t) => addToComparisonSet(t, nobody, sub.key, BY))).rejects.toThrow();
      expect(await listComparisonCandidates(tx, sub.key)).toEqual([]);
      expect((await listComparisonCandidates(tx, neighbour.key)).map((c) => c.placeId)).toEqual([foreign]);
      await addToComparisonSet(tx, foreign, neighbour.key, BY);
      expect(await comparisonSetSize(tx, neighbour.key)).toBe(1);
    }));

  it("adding twice keeps one row", () =>
    withRollback(async (tx) => {
      const sub = await insertSubdivision(tx);
      await insertTile(tx, sub.id);
      const place = await insertPlace(tx, "confirmed", "Doppelt", sub.id);
      await addToComparisonSet(tx, place, sub.key, BY);
      await addToComparisonSet(tx, place, sub.key, "other@example.invalid");
      expect(await comparisonSetSize(tx, sub.key)).toBe(1);
      const rows = await listComparisonCandidates(tx, sub.key);
      expect(rows).toEqual([{ placeId: place, name: "Doppelt", kind: "anchorage", tileId: TILE, inSet: true }]);
      await removeFromComparisonSet(tx, place);
      expect(await comparisonSetSize(tx, sub.key)).toBe(0);
      expect((await listComparisonCandidates(tx, sub.key))[0]!.inSet).toBe(false);
    }));

  it("size counts per subdivision", () =>
    withRollback(async (tx) => {
      const a = await insertSubdivision(tx);
      const b = await insertSubdivision(tx);
      await insertTile(tx, a.id);
      const place = await insertPlace(tx, "confirmed", "Eins", a.id);
      await addToComparisonSet(tx, place, a.key, BY);
      expect(await comparisonSetSize(tx, a.key)).toBe(1);
      expect(await comparisonSetSize(tx, b.key)).toBe(0);
      expect(await listComparisonCandidates(tx, b.key)).toEqual([]);
    }));

  it("an unknown subdivision and a leftover area key are refused with the subdivision to use", () =>
    withRollback(async (tx) => {
      await expect(comparisonSetSize(tx, `nope-${newId()}`)).rejects.toThrow(/Unbekannter Landesteil nope-/);
      await expect(listComparisonCandidates(tx, "saronic")).rejects.toThrow(/Revier-Schlüssel saronic ist kein Laufumfang mehr/);
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
  it("is null for an unknown subdivision", () =>
    withRollback(async (tx) => {
      expect(await comparisonOverview(tx, `not-created-${newId()}`)).toBeNull();
    }));

  it("lists the candidates and the set size of an existing subdivision", () =>
    withRollback(async (tx) => {
      const sub = await insertSubdivision(tx);
      expect(await comparisonOverview(tx, sub.key)).toEqual({ candidates: [], size: 0 });
      await insertTile(tx, sub.id);
      const placeId = await insertPlace(tx, "confirmed", "Testbucht", sub.id);
      await addToComparisonSet(tx, placeId, sub.key, BY);
      expect(await comparisonOverview(tx, sub.key)).toEqual({
        candidates: [{ placeId, name: "Testbucht", kind: "anchorage", tileId: TILE, inSet: true }],
        size: 1,
      });
    }));
});
