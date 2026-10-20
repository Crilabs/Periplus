import path from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { comparisonSet, places, tiles } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { insertProfile, provenanceEntry } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertNamedObject } from "@/test/text";
import { acceptNavilyProposals, areaComparisonView, confirmedAreaPlaces } from "../navily-compare";
import { loadNavilySpots } from "../navily-sample";

// Synthetic area around the fixture spots at 21.0–21.1° E / 35.2–35.3° N (outside the pilot box), rolled back.

const settings = { cfg: getConfig().quality.navily, affixes: getConfig().nameAffixes };
const FIXTURE = path.join(process.cwd(), "test/fixtures/navily/sample.json");

async function scene(tx: Db) {
  const areaKey = `test-${newId()}`;
  const areaId = await insertNamedObject(tx, { type: "area", names: [{ name: "Test area" }], lon: 21.05, lat: 35.25, configKey: areaKey });
  for (const [lon, lat] of [
    [21.0, 35.2],
    [21.05, 35.25],
  ]) {
    const id = tileIdFor(lon!, lat!);
    const [w, s, e, n] = tileBbox(id);
    await tx
      .insert(tiles)
      .values({ id, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, areaId })
      .onConflictDoUpdate({ target: tiles.id, set: { areaId } });
  }
  const addPlace = async (name: string, lon: number, lat: number, inSet: boolean) => {
    const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name }], lon, lat });
    const [p] = await tx
      .insert(places)
      .values({
        geoObjectId: objectId,
        kind: "anchorage",
        status: "confirmed",
        tileId: tileIdFor(lon, lat),
        position: geomFromGeoJson({ type: "Point", coordinates: [lon, lat] }),
      })
      .returning({ id: places.id });
    if (inSet) await tx.insert(comparisonSet).values({ placeId: p!.id, areaId, addedBy: "test" });
    return { placeId: p!.id, objectId };
  };
  const kolona = await addPlace("Kolona", 21.0, 35.2, true);
  const other = await addPlace("Vathi", 21.06, 35.26, false);
  await insertProfile(tx, kolona.objectId, { "services.water": true, "shelter.N": 0.9 }, { "shelter.N": provenanceEntry("computed") }, { version: 1 });
  return { areaKey, kolona, other };
}

describe("areaComparisonView", () => {
  it("without a navily file shows own values and stored outcomes only", () =>
    withRollback(async (tx) => {
      const { areaKey, kolona } = await scene(tx);
      const view = await areaComparisonView(tx, { areaKey, spots: null, ...settings });
      expect(view.places.map((p) => p.subject.placeId)).toEqual([kolona.placeId]);
      expect(view.places[0]!.rows.every((r) => r.proposal === null && r.stored === null)).toBe(true);
      expect([view.places[0]!.open, view.checked, view.total, view.coverage, view.unmatchedSpots]).toEqual([16, 0, 16, null, []]);
    }));

  it("with spots proposes per attribute, counts coverage over all confirmed places and lists unmatched spots", () =>
    withRollback(async (tx) => {
      const { areaKey, kolona, other } = await scene(tx);
      const spots = await loadNavilySpots(FIXTURE);
      expect((await confirmedAreaPlaces(tx, areaKey)).map((p) => p.placeId).sort()).toEqual([kolona.placeId, other.placeId].sort());

      const view = await areaComparisonView(tx, { areaKey, spots, ...settings });
      const place = view.places[0]!;
      expect(place.spot?.name).toBe("NAVILY-ONLY-NAME");
      expect(place.positionDistanceM).toBe(0);
      const proposal = Object.fromEntries(place.rows.map((r) => [r.attribute, r.proposal]));
      expect(proposal).toMatchObject({ existence: "match", "services.water": "match", "shelter.N": "match", "shelter.S": "deviation" });
      // spot 0 → Kolona; spot 1 (port) and spot 2 (nameless, 21.1/35.3) lie in the area's tiles but match no place
      expect(view.coverage).toEqual({ spots: 3, matched: 1, ratio: 1 / 3 });
      expect(view.unmatchedSpots.map((u) => [u.spot.name, u.nearest?.placeId])).toEqual([
        ["NAVILY-PORT", other.placeId],
        [null, other.placeId],
      ]);
    }));

  it("counts checked attributes and marks outcomes carried over from another profile version", () =>
    withRollback(async (tx) => {
      const { areaKey, kolona } = await scene(tx);
      const spots = await loadNavilySpots(FIXTURE);
      expect(await acceptNavilyProposals(tx, { areaKey, placeId: kolona.placeId, spots, checkedBy: "admin@test", ...settings })).toMatchObject({
        written: 16,
      });
      let view = await areaComparisonView(tx, { areaKey, spots, ...settings });
      expect([view.places[0]!.open, view.checked]).toEqual([0, 16]);
      expect(view.places[0]!.rows.every((r) => r.stored?.carried === false && r.stored.method === "proposal_confirmed")).toBe(true);

      // a new profile version: the unchanged values keep their outcome (carried), the changed one is open again
      await insertProfile(tx, kolona.objectId, { "services.water": false, "shelter.N": 0.9 }, { "shelter.N": provenanceEntry("computed") }, {
        version: 2,
        validFrom: "2026-10-20",
      });
      view = await areaComparisonView(tx, { areaKey, spots, ...settings });
      const rows = Object.fromEntries(view.places[0]!.rows.map((r) => [r.attribute, r.stored]));
      expect(rows["services.water"]).toBeNull();
      expect(rows["shelter.N"]).toMatchObject({ result: "match", carried: true });
      expect([view.places[0]!.open, view.checked]).toEqual([1, 15]);
    }));
});
