import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, tiles } from "@/lib/db/schema";
import { recordComputation } from "@/lib/domain/facts/computations";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { addNames } from "@/lib/domain/gazetteer/names";
import { newId } from "@/lib/domain/ids";
import { tileBbox } from "@/lib/domain/tiles";
import { computePlaceGeometry } from "@/lib/pipeline/geometry";
import { withRollback } from "@/test/db";
import { buildBayScene, insertScenePlace } from "@/test/geometry/scene";
import { checkGeometry } from "../check";

const TODAY = "2026-10-19";

/** An area geo object labelling `tileIds` as its coast tiles; returns the area key. */
async function areaOver(tx: Db, tileIds: string[]): Promise<string> {
  const areaKey = `test-${newId()}`;
  const [area] = await tx
    .insert(geoObjects)
    .values({ type: "area", origin: "manual", configKey: areaKey, geom: sql`${geomFromGeoJson({ type: "Point", coordinates: [21, 35.24] })}` })
    .returning({ id: geoObjects.id });
  for (const tileId of new Set(tileIds)) {
    const [w, s, e, n] = tileBbox(tileId);
    await tx
      .insert(tiles)
      .values({ id: tileId, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, areaId: area!.id, hasCoast: true })
      .onConflictDoUpdate({ target: tiles.id, set: { areaId: area!.id, hasCoast: true } });
  }
  return areaKey;
}

const record = (tx: Db, geoObjectId: string, kind: "shelter" | "depth", facts: Array<{ attribute: string; value: unknown }>, outputs = {}) =>
  recordComputation(tx, {
    geoObjectId,
    kind,
    inputs: { test: newId() },
    outputs,
    rulesVersion: "geometry-test",
    facts: facts.map((f) => ({ ...f, confidence: 0.5 })),
    observedAt: TODAY,
  });

describe("checkGeometry", () => {
  it("reports a place with 7 shelter facts as missing and counts a depth gap as complete", () =>
    withRollback(async (tx) => {
      const scene = await buildBayScene(tx);
      const sevenSectors = await insertScenePlace(tx, -5000, -3000, { status: "confirmed" });
      const depthGap = await insertScenePlace(tx, 5000, -3000, { status: "confirmed" });
      const bare = await insertScenePlace(tx, -6000, -3000);
      const rejected = await insertScenePlace(tx, 6000, -3000, { status: "rejected" }); // not computed by the stage
      await addNames(tx, sevenSectors.geoObjectId, [{ name: "Siebenbucht", language: "de", origin: "manual" }]);
      const areaKey = await areaOver(tx, [scene, sevenSectors, depthGap, bare, rejected].map((p) => p.tileId));

      await computePlaceGeometry(tx, scene.placeId, { today: TODAY });
      const opening = { attribute: "opening_bearing", value: { bearingDeg: 180, widthDeg: 90 } };
      await record(tx, sevenSectors.geoObjectId, "shelter", [
        ...SECTORS.slice(0, 7).map((s) => ({ attribute: `shelter.${s}`, value: 0.5 })),
        opening,
      ]);
      await record(tx, sevenSectors.geoObjectId, "depth", [{ attribute: "depth.min", value: 4 }]);
      await record(tx, depthGap.geoObjectId, "shelter", [...SECTORS.map((s) => ({ attribute: `shelter.${s}`, value: 0.5 })), opening]);
      await record(tx, depthGap.geoObjectId, "depth", [], {
        gaps: [
          { attribute: "depth.approach", reason: "no_bathymetry" },
          { attribute: "depth.min", reason: "no_bathymetry" },
        ],
      });

      const r = await checkGeometry(tx, areaKey);
      expect(r.places).toBe(4);
      expect(r.complete).toBe(2);
      expect(r.missing).toEqual(
        [
          { placeId: sevenSectors.placeId, name: "Siebenbucht", missing: ["shelter.NW"] },
          { placeId: bare.placeId, name: "(ohne Namen)", missing: [...SECTORS.map((s) => `shelter.${s}`), "opening_bearing", "depth"] },
        ].sort((a, b) => a.name.localeCompare(b.name) || a.placeId.localeCompare(b.placeId)),
      );
      expect(r.depthGaps).toEqual([{ placeId: depthGap.placeId, name: "(ohne Namen)", reason: "no_bathymetry" }]);
    }));

  it("reports a place whose newest anchor area has no water as missing despite older shelter facts", () =>
    withRollback(async (tx) => {
      const place = await insertScenePlace(tx, -5000, -3000, { status: "confirmed" });
      const areaKey = await areaOver(tx, [place.tileId]);
      await record(tx, place.geoObjectId, "shelter", [
        ...SECTORS.map((s) => ({ attribute: `shelter.${s}`, value: 0.5 })),
        { attribute: "opening_bearing", value: { bearingDeg: 180, widthDeg: 90 } },
      ]);
      await record(tx, place.geoObjectId, "depth", [{ attribute: "depth.min", value: 4 }]);
      await recordComputation(tx, {
        geoObjectId: place.geoObjectId,
        kind: "anchor_area",
        inputs: { test: newId() },
        outputs: {
          gaps: [
            { attribute: "shelter.*", reason: "no_water" },
            { attribute: "fetch.*", reason: "no_water" },
            { attribute: "depth.*", reason: "no_water" },
          ],
        },
        rulesVersion: "geometry-test",
        facts: [],
        observedAt: TODAY,
      });

      const r = await checkGeometry(tx, areaKey);
      expect(r.complete).toBe(0);
      expect(r.missing).toEqual([
        { placeId: place.placeId, name: "(ohne Namen)", missing: [...SECTORS.map((s) => `shelter.${s}`), "opening_bearing", "depth"] },
      ]);
      expect(r.depthGaps).toEqual([]);
    }));

  it("throws for an unknown area", () =>
    withRollback(async (tx) => {
      await expect(checkGeometry(tx, `test-${newId()}`)).rejects.toThrow(/Unknown area/);
    }));
});
