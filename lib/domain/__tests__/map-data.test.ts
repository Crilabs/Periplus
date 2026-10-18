import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, places, tiles, type GeoObjectType, type PlaceStatus } from "@/lib/db/schema";
import { tileBbox, tileIdFor, type Bbox } from "@/lib/domain/tiles";
import { mapLayer } from "@/lib/domain/map-data";
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

  it("areas and tiles carry their keys and counts", () =>
    withRollback(async (tx) => {
      const key = `test-area-${LON}`;
      const area = await insertObject(tx, { type: "area", geom: square(LON - 0.1, LAT - 0.1, 0.2), configKey: key, names: [["Testrevier", "de", true]] });
      const tileId = tileIdFor(LON, LAT);
      const [w, s] = tileBbox(tileId);
      await tx.insert(tiles).values({
        id: tileId,
        bbox: sql`${geomFromGeoJson(square(w, s, 0.25))}`,
        areaId: area,
        hasCoast: true,
      });
      // places.tile_id is set from the position by trigger.
      for (const [i, status] of (["candidate", "candidate", "confirmed"] as const).entries()) {
        await insertPlace(tx, `P${i}`, LON + i * 0.001, LAT, status);
      }
      await insertPlace(tx, "Ended", LON + 0.004, LAT, "candidate", "2020-01-01");

      const areas = await mapLayer(tx, "areas", BOX);
      expect(areas.features.find((f) => f.properties!.id === area)!.properties).toEqual({ id: area, key, name: "Testrevier" });

      const tileLayer = await mapLayer(tx, "tiles", BOX);
      expect(tileLayer.features.find((f) => f.properties!.id === tileId)!.properties).toEqual({
        id: tileId,
        hasCoast: true,
        areaKey: key,
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
        properties: { id: candidate, kind: "anchorage", status: "candidate", name: "Candidate Cove", publicId: null },
      });
      expect(fc.features.find((f) => f.properties!.id === rejected)!.properties!.status).toBe("rejected");
    }));

  it("limit caps the feature count", () =>
    withRollback(async (tx) => {
      for (let i = 0; i < 4; i++) await insertPlace(tx, `Cove ${i}`, LON + i * 0.001, LAT, "candidate");
      expect((await mapLayer(tx, "places", BOX, { limit: 2 })).features).toHaveLength(2);
      expect((await mapLayer(tx, "places", BOX)).features).toHaveLength(4);
    }));
});
