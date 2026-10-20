import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  geoNames,
  geoObjects,
  places,
  restrictedAreas,
  tiles,
  type GeoObjectType,
  type PlaceStatus,
  type RestrictedKind,
} from "@/lib/db/schema";
import { tileBbox, tileIdFor, type Bbox } from "@/lib/domain/tiles";
import { mapLayer } from "@/lib/domain/map-data";
import { insertTestSubdivision } from "@/test/text";
import { withRollback } from "@/test/db";

// Synthetic data in open sea outside the pilot box 23.0-23.75 E x 37.0-38.0 N, at a spot no other test uses.
const LON = 27.13;
const LAT = 33.13;
const BOX: Bbox = [LON - 0.05, LAT - 0.05, LON + 0.05, LAT + 0.05];
const point = (lon: number, lat: number): GeoJSON.Point => ({ type: "Point", coordinates: [lon, lat] });
const square = (lon: number, lat: number, size: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]],
});

async function insertObject(
  tx: Db,
  o: { type: GeoObjectType; geom: GeoJSON.Geometry; names?: [string, string, boolean?][]; parentId?: string; configKey?: string; validTo?: string },
): Promise<string> {
  const [row] = await tx
    .insert(geoObjects)
    .values({
      type: o.type,
      origin: "manual",
      geom: sql`${geomFromGeoJson(o.geom)}`,
      parentId: o.parentId,
      configKey: o.configKey,
      validTo: o.validTo,
      category: o.type === "poi" ? "beach" : undefined,
    })
    .returning({ id: geoObjects.id });
  for (const [name, language, isPreferred] of o.names ?? []) {
    await tx.insert(geoNames).values({
      geoObjectId: row!.id,
      name,
      nameNormalized: name.toLowerCase(),
      language,
      script: "latin",
      origin: "manual",
      isPreferred: isPreferred ?? false,
    });
  }
  return row!.id;
}

async function insertPlace(
  tx: Db,
  name: string,
  lon: number,
  lat: number,
  status: PlaceStatus,
  validTo?: string,
): Promise<string> {
  const geoObjectId = await insertObject(tx, { type: "bay", geom: point(lon, lat), names: [[name, "en", true]] });
  const [row] = await tx
    .insert(places)
    .values({ geoObjectId, kind: "anchorage", status, validTo, position: sql`${geomFromGeoJson(point(lon, lat))}` })
    .returning({ id: places.id });
  return row!.id;
}

const ids = (fc: GeoJSON.FeatureCollection) => fc.features.map((f) => f.properties!.id as string).sort();

describe("mapLayer", () => {
  it("mapLayer returns only features intersecting the bbox", () =>
    withRollback(async (tx) => {
      const parent = await insertObject(tx, {
        type: "island",
        geom: square(LON - 0.02, LAT - 0.02, 0.04),
        names: [["Testinsel", "de", true], ["Test Island", "en", true], ["Τεστ", "el", true]],
      });
      const inside = await insertObject(tx, {
        type: "bay",
        geom: point(LON, LAT),
        parentId: parent,
        names: [["Test Bay", "en", true], ["Όρμος", "el", true]],
      });
      // Polygon reaching into the box from outside counts as intersecting.
      const overlapping = await insertObject(tx, { type: "cape", geom: square(LON + 0.04, LAT, 0.1), names: [["Akra", "el", true]] });
      await insertObject(tx, { type: "bay", geom: point(LON + 0.2, LAT), names: [["Far Bay", "en", true]] });
      await insertObject(tx, { type: "bay", geom: point(LON + 0.01, LAT), names: [["Ended Bay", "en", true]], validTo: "2020-01-01" });

      const fc = await mapLayer(tx, "geo-objects", BOX);
      expect(fc.type).toBe("FeatureCollection");
      expect(ids(fc)).toEqual([parent, inside, overlapping].sort());
      const bay = fc.features.find((f) => f.properties!.id === inside)!;
      expect(bay.geometry).toEqual(point(LON, LAT));
      expect(bay.properties).toEqual({ id: inside, type: "bay", category: null, name: "Test Bay", parentName: "Testinsel" });
      expect(fc.features.find((f) => f.properties!.id === overlapping)!.properties!.name).toBe("Akra");
    }));

  it("areas, subdivisions, seas and tiles carry their keys and counts", () =>
    withRollback(async (tx) => {
      const key = `test-area-${LON}`;
      const sub = await insertTestSubdivision(tx, "XT-MAP", [LON - 0.5, LAT - 0.5, LON + 0.5, LAT + 0.5], { country: "XT" });
      const sea = await insertObject(tx, { type: "sea", geom: square(LON - 1, LAT - 1, 2), names: [["Testmeer", "de", true]] });
      const area = await insertObject(tx, { type: "area", geom: square(LON - 0.1, LAT - 0.1, 0.2), configKey: key, names: [["Testrevier", "de", true]] });
      const tileId = tileIdFor(LON, LAT);
      const [w, s] = tileBbox(tileId);
      await tx.insert(tiles).values({
        id: tileId,
        bbox: sql`${geomFromGeoJson(square(w, s, 0.25))}`,
        subdivisionId: sub.id,
        hasCoast: true,
      });
      // places.tile_id is set from the position by trigger.
      for (const [i, status] of (["candidate", "candidate", "confirmed"] as const).entries()) {
        await insertPlace(tx, `P${i}`, LON + i * 0.001, LAT, status);
      }
      await insertPlace(tx, "Ended", LON + 0.004, LAT, "candidate", "2020-01-01");

      const areas = await mapLayer(tx, "areas", BOX);
      expect(areas.features.find((f) => f.properties!.id === area)!.properties).toEqual({ id: area, key, name: "Testrevier" });

      const subdivisionLayer = await mapLayer(tx, "subdivisions", BOX);
      expect(subdivisionLayer.features.find((f) => f.properties!.key === "XT-MAP")!.properties).toEqual({ key: "XT-MAP", country: "XT", status: "active", name: null });
      expect((await mapLayer(tx, "seas", BOX)).features.map((f) => f.properties!.id)).toContain(sea);
      // seas, countries and admin regions are no geo-object features
      expect((await mapLayer(tx, "geo-objects", BOX)).features.map((f) => f.properties!.id)).not.toContain(sea);
      expect((await mapLayer(tx, "geo-objects", BOX)).features.map((f) => f.properties!.id)).not.toContain(sub.geoObjectId);

      const tileLayer = await mapLayer(tx, "tiles", BOX);
      expect(tileLayer.features.find((f) => f.properties!.id === tileId)!.properties).toEqual({
        id: tileId,
        hasCoast: true,
        subdivisionKey: "XT-MAP",
        placeCount: 3,
        candidateCount: 2,
      });
    }));

  it("places carry status and kind", () =>
    withRollback(async (tx) => {
      const candidate = await insertPlace(tx, "Candidate Cove", LON, LAT, "candidate");
      const rejected = await insertPlace(tx, "Rejected Cove", LON + 0.001, LAT, "rejected");
      await insertPlace(tx, "Outside Cove", LON + 0.3, LAT, "confirmed");

      const fc = await mapLayer(tx, "places", BOX);
      expect(ids(fc)).toEqual([candidate, rejected].sort());
      expect(fc.features.find((f) => f.properties!.id === candidate)).toEqual({
        type: "Feature",
        geometry: point(LON, LAT),
        properties: {
          id: candidate,
          kind: "anchorage",
          status: "candidate",
          name: "Candidate Cove",
          publicId: null,
          // without a profile (profile-view.test.ts covers places with one)
          hasProfile: false,
          profileConfidence: null,
          profileClass: null,
        },
      });
      expect(fc.features.find((f) => f.properties!.id === rejected)!.properties!.status).toBe("rejected");
    }));

  it("limit caps the feature count and says the layer was cut (UI-12)", () =>
    withRollback(async (tx) => {
      for (let i = 0; i < 4; i++) await insertPlace(tx, `Cove ${i}`, LON + i * 0.001, LAT, "candidate");
      const cut = await mapLayer(tx, "places", BOX, { limit: 2 });
      expect(cut.features).toHaveLength(2);
      expect(cut.truncated).toBe(true);
      expect(await mapLayer(tx, "places", BOX, { limit: 4 })).toMatchObject({ truncated: false });
      const all = await mapLayer(tx, "places", BOX);
      expect(all.features).toHaveLength(4);
      expect(all.truncated).toBe(false);
    }));

  it("geo objects are filtered by type in the query, so the cap counts only the types shown (UI-12)", () =>
    withRollback(async (tx) => {
      for (let i = 0; i < 3; i++) await insertObject(tx, { type: "cape", geom: point(LON + 0.01 + i * 0.001, LAT + 0.01) });
      const bay = await insertObject(tx, { type: "bay", geom: point(LON + 0.02, LAT + 0.02) });
      const bays = await mapLayer(tx, "geo-objects", BOX, { limit: 1, types: ["bay"] });
      expect(ids(bays)).toEqual([bay]);
      expect(bays.truncated).toBe(false);
      expect((await mapLayer(tx, "geo-objects", BOX, { limit: 1 })).truncated).toBe(true);
      expect((await mapLayer(tx, "geo-objects", BOX, { types: [] })).features).toEqual([]);
    }));

  it("restricted-areas layer returns only valid areas in the bbox with anchoringBan", () =>
    withRollback(async (tx) => {
      const insertArea = async (kind: RestrictedKind, sourceRef: string, geom: GeoJSON.Polygon, validTo?: string) => {
        const [row] = await tx
          .insert(restrictedAreas)
          .values({ kind, sourceRef, geom: sql`${geomFromGeoJson(geom)}`, validFrom: "2020-01-01", validTo })
          .returning({ id: restrictedAreas.id });
        return row!.id;
      };
      const military = await insertArea("military", "test-military:1", square(LON - 0.01, LAT - 0.01, 0.02));
      const park = await insertArea("protected_area", "test-natura/GR0000000", square(LON + 0.03, LAT, 0.05));
      await insertArea("cable", "test-cable:far", square(LON + 0.3, LAT, 0.01));

      const fc = await mapLayer(tx, "restricted-areas", BOX);
      expect(ids(fc)).toEqual([military, park].sort());
      const militaryFeature = fc.features.find((f) => f.properties!.id === military)!;
      expect(militaryFeature.geometry.type).toBe("Polygon");
      expect(militaryFeature.properties).toEqual({ id: military, kind: "military", sourceRef: "test-military:1", anchoringBan: true });
      expect(fc.features.find((f) => f.properties!.id === park)!.properties).toEqual({
        id: park,
        kind: "protected_area",
        sourceRef: "test-natura/GR0000000",
        anchoringBan: false,
      });
      // A protected area listed in the ban config bans anchoring.
      const banned = await mapLayer(tx, "restricted-areas", BOX, {
        anchoringBan: { noAnchoringKinds: [], protectedAreaAnchoringBan: ["GR0000000"] },
      });
      expect(banned.features.find((f) => f.properties!.id === park)!.properties!.anchoringBan).toBe(true);
      expect(banned.features.find((f) => f.properties!.id === military)!.properties!.anchoringBan).toBe(false);
    }));

  it("an ended area is not on the map", () =>
    withRollback(async (tx) => {
      const [ended] = await tx
        .insert(restrictedAreas)
        .values({
          kind: "aquaculture",
          sourceRef: "test-aquaculture:ended",
          geom: sql`${geomFromGeoJson(square(LON, LAT, 0.01))}`,
          validFrom: "2020-01-01",
          validTo: "2021-01-01",
        })
        .returning({ id: restrictedAreas.id });
      const fc = await mapLayer(tx, "restricted-areas", BOX);
      expect(ids(fc)).not.toContain(ended!.id);
    }));
});
