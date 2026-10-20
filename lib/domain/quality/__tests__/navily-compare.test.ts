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
import { acceptNavilyProposals, areaComparisonView, confirmedAreaPlaces, proposalDigest } from "../navily-compare";
import { loadNavilySpots, type NavilySpot } from "../navily-sample";

// Synthetic area around the fixture spots, shifted by DLON to 51.0–51.1° E / 35.2–35.3° N (outside the pilot box), rolled back.

const settings = { cfg: getConfig().quality.navily, affixes: getConfig().nameAffixes };
const FIXTURE = path.join(process.cwd(), "test/fixtures/navily/sample.json");
/**
 * This file's whole-tile longitude shift: the fixture spots (21.0–21.1° E) and the scene move to 51° E, so no other
 * test file inserts the same tile row and waits on it until rollback (final review A M-1).
 */
const DLON = 30;
const loadSpots = async () => (await loadNavilySpots(FIXTURE)).map((s) => ({ ...s, lon: s.lon + DLON }));

async function scene(tx: Db) {
  const areaKey = `test-${newId()}`;
  const areaId = await insertNamedObject(tx, { type: "area", names: [{ name: "Test area" }], lon: 51.05, lat: 35.25, configKey: areaKey });
  for (const [lon, lat] of [
    [51.0, 35.2],
    [51.05, 35.25],
  ]) {
    const id = tileIdFor(lon!, lat!);
    const [w, s, e, n] = tileBbox(id);
    await tx
      .insert(tiles)
      .values({ id, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, areaId })
      .onConflictDoUpdate({ target: tiles.id, set: { areaId } });
  }
  const addPlace = async (name: string, lon: number, lat: number, inSet: boolean, kind: "anchorage" | "port" = "anchorage") => {
    const objectId = await insertNamedObject(tx, { type: kind === "port" ? "harbour" : "bay", names: [{ name }], lon, lat });
    const [p] = await tx
      .insert(places)
      .values({
        geoObjectId: objectId,
        kind,
        status: "confirmed",
        tileId: tileIdFor(lon, lat),
        position: geomFromGeoJson({ type: "Point", coordinates: [lon, lat] }),
      })
      .returning({ id: places.id });
    if (inSet) await tx.insert(comparisonSet).values({ placeId: p!.id, areaId, addedBy: "test" });
    return { placeId: p!.id, objectId };
  };
  const kolona = await addPlace("Kolona", 51.0, 35.2, true);
  const other = await addPlace("Vathi", 51.06, 35.26, false);
  await insertProfile(tx, kolona.objectId, { "services.water": true, "shelter.N": 0.9 }, { "shelter.N": provenanceEntry("computed") }, { version: 1 });
  return { areaKey, kolona, other, addPlace };
}

/** A synthetic spot `north` metres north and `east` metres east of 51.0° E / 35.2° N (outside the pilot box). */
function spotAt(north: number, east: number, over: Partial<NavilySpot> = {}): NavilySpot {
  const lat = 35.2 + north / 111_195;
  return { lat, lon: 51.0 + east / (111_195 * Math.cos((lat * Math.PI) / 180)), prot: null, seabeds: null, name: null, kind: "mooring", type: null, water: null, shop: null, ...over };
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
      const spots = await loadSpots();
      expect((await confirmedAreaPlaces(tx, areaKey)).map((p) => p.placeId).sort()).toEqual([kolona.placeId, other.placeId].sort());

      const view = await areaComparisonView(tx, { areaKey, spots, ...settings });
      const place = view.places[0]!;
      expect(place.spot?.name).toBe("NAVILY-ONLY-NAME");
      expect(place.positionDistanceM).toBeGreaterThan(30);
      expect(place.positionDistanceM).toBeLessThan(50);
      const proposal = Object.fromEntries(place.rows.map((r) => [r.attribute, r.proposal]));
      expect(proposal).toMatchObject({ existence: "match", "services.water": "match", "shelter.N": "match", "shelter.S": "deviation" });
      // spot 0 → Kolona; spot 1 (port) and spot 2 (nameless, 51.1/35.3) lie in the area's tiles but match no place
      expect(view.coverage).toEqual({ spots: 3, matched: 1, ratio: 1 / 3 });
      expect(view.unmatchedSpots.map((u) => [u.spot.name, u.nearest?.placeId])).toEqual([
        ["NAVILY-PORT", other.placeId],
        [null, other.placeId],
      ]);
    }));

  it("matches the set against all confirmed places of the area: the village harbour keeps its port, the bay gets its mooring", () =>
    withRollback(async (tx) => {
      const { areaKey, addPlace } = await scene(tx);
      // the bay Vathi is in the set; the harbour Vathi 800 m east is a confirmed place of the area outside the set
      const bay = await addPlace("Vathi", 51.0 + 300 / 90_850, 35.2, true);
      const harbour = await addPlace("Vathi", 51.0 + 1100 / 90_850, 35.2, false, "port");
      const spots = [spotAt(0, 1100, { name: "Vathi", kind: "port" }), spotAt(0, 350, { name: "Vathy" })];
      const view = await areaComparisonView(tx, { areaKey, spots, ...settings });
      const bayView = view.places.find((p) => p.subject.placeId === bay.placeId)!;
      expect(bayView.match?.spotIndex).toBe(1);
      expect(view.places.map((p) => p.subject.placeId)).not.toContain(harbour.placeId);
      // both spots have a confirmed place: the coverage agrees with the proposals
      expect(view.coverage).toMatchObject({ matched: 2 });
    }));

  it("coverage and matching use the delivered point from the profile: the anchor position of a bay", () =>
    withRollback(async (tx) => {
      const { areaKey, other } = await scene(tx);
      // Vathi (outside the set) delivers its anchor position 300 m north of its place point
      const anchor = { lon: 51.06, lat: 35.26 + 300 / 111_195 };
      await insertProfile(tx, other.objectId, { anchor_position: anchor }, {}, { version: 1 });
      const areaPlaces = await confirmedAreaPlaces(tx, areaKey);
      expect(areaPlaces.find((p) => p.placeId === other.placeId)).toMatchObject({ anchorPosition: anchor, status: "confirmed" });
      const spots = [{ ...spotAt(0, 0), ...anchor }];
      const view = await areaComparisonView(tx, { areaKey, spots, ...settings });
      expect(view.coverage).toEqual({ spots: 1, matched: 1, ratio: 1 });
    }));

  it("gives each place the digest of the proposals it shows", () =>
    withRollback(async (tx) => {
      const { areaKey } = await scene(tx);
      expect((await areaComparisonView(tx, { areaKey, spots: null, ...settings })).places[0]!.digest).toBeNull();
      const view = await areaComparisonView(tx, { areaKey, spots: await loadSpots(), ...settings });
      const place = view.places[0]!;
      expect(place.digest).toBe(proposalDigest(place.rows.map((r) => ({ attribute: r.attribute, valueHash: r.value.hash, proposal: r.proposal! }))));
      expect(place.digest).toMatch(/^[0-9a-f]{16}$/);
    }));

  it("counts checked attributes and marks outcomes carried over from another profile version", () =>
    withRollback(async (tx) => {
      const { areaKey, kolona } = await scene(tx);
      const spots = await loadSpots();
      let view = await areaComparisonView(tx, { areaKey, spots, ...settings });
      const digest = view.places[0]!.digest!;
      expect(await acceptNavilyProposals(tx, { areaKey, placeId: kolona.placeId, spots, digest, checkedBy: "admin@test", ...settings })).toMatchObject({
        written: 16,
      });
      view = await areaComparisonView(tx, { areaKey, spots, ...settings });
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
