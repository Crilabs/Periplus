import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { tileGeoObjects } from "@/lib/db/schema";
import { consolidationScope, consolidationTargets, reselectionTargets } from "@/lib/domain/consolidation/targets";
import { mergeGeoObjects } from "@/lib/domain/gazetteer/merge";
import { newId } from "@/lib/domain/ids";
import { tileIdFor } from "@/lib/domain/tiles";
import { insertMention, insertPlace, insertSource } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";
import { insertNamedObject, insertTestRun, insertTestTile } from "@/test/text";

/*
 * POIs of a run's scope leave its targets (spec 16); the places within the largest highlight reach of them only
 * re-select (`reselectionTargets`, final review C1), explicit runs included (final review I2). Objects on a synthetic
 * spot far from the pilot box and the other tests' objects.
 */

const LON = -141.2;
const LAT = -46.3;
const LAT_PER_KM = 1 / 111.1;
const TILE = tileIdFor(LON, LAT);

let today = "";
beforeAll(async () => {
  const { rows } = await testDb().execute<{ today: string }>(sql`select current_date::text as today`);
  today = rows[0]!.today;
});

const poi = (tx: Db, name: string, km: number) =>
  insertNamedObject(tx, { type: "poi", category: "culture", names: [{ name }], lon: LON, lat: LAT + km * LAT_PER_KM });

describe("consolidationTargets with POIs (spec 16)", () => {
  it("a text run with a mention on a POI re-selects the places within 20 km and targets neither them nor the POI", () =>
    withRollback(async (tx) => {
      const near = await insertPlace(tx, { lon: LON, lat: LAT, name: "Nahbucht" });
      const far = await insertPlace(tx, { lon: LON, lat: LAT - 10 * LAT_PER_KM, name: "Fernbucht" });
      const candidate = await insertPlace(tx, { lon: LON, lat: LAT + 30 * LAT_PER_KM, name: "Kandidatenbucht", status: "candidate" });
      const rejected = await insertPlace(tx, { lon: LON, lat: LAT + 20 * LAT_PER_KM, name: "Abgelehnt", status: "rejected" });
      // the POI lies 15 km from `near`, 25 km from `far`, 15 km from the candidate
      const castle = await poi(tx, "Kastro", 15);
      const runId = await insertTestRun(tx);
      const m = await insertMention(tx, castle, { sourceId: await insertSource(tx), runId });
      const run = { id: runId, params: { documentVersionIds: [m.versionId] } };
      expect(await consolidationTargets(tx, run, today)).toEqual([]);
      const reselect = await reselectionTargets(tx, run, today);
      expect(reselect).toEqual([near.objectId, candidate.objectId].sort());
      expect(reselect).not.toContain(far.objectId);
      expect(reselect).not.toContain(rejected.objectId);
      // a catch-up of the run names its scope with the POI
      expect(await consolidationScope(tx, run, today)).toEqual([castle]);
    }));

  it("a tile run excludes POIs", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, TILE);
      const bay = await insertPlace(tx, { lon: LON, lat: LAT, name: "Kachelbucht" });
      const beach = await poi(tx, "Strand", 1);
      for (const id of [bay.objectId, beach]) await tx.insert(tileGeoObjects).values({ tileId: TILE, geoObjectId: id });
      const run = { id: newId(), params: { tileId: TILE } };
      expect(await consolidationTargets(tx, run, today)).toEqual([bay.objectId]);
      // the bay is a target already: it is not re-selected besides
      expect(await reselectionTargets(tx, run, today)).toEqual([]);
    }));

  it("explicit geoObjectIds stay exactly the given objects, POIs included; rules without highlights keep POI targets", () =>
    withRollback(async (tx) => {
      const bay = await insertPlace(tx, { lon: LON, lat: LAT, name: "Direktbucht" });
      const castle = await poi(tx, "Kastro", 2);
      const direct = { id: newId(), params: { geoObjectIds: [castle] } };
      expect(await consolidationTargets(tx, direct, today)).toEqual([castle]);
      // the places within reach of the given POI re-select (final review I2)
      expect(await reselectionTargets(tx, direct, today)).toEqual([bay.objectId]);
      const runId = await insertTestRun(tx);
      const m = await insertMention(tx, castle, { sourceId: await insertSource(tx), runId });
      const v1 = await consolidationTargets(tx, { id: runId, params: { documentVersionIds: [m.versionId], rulesVersion: "v1" } }, today);
      expect(v1).toEqual([castle]);
      expect(v1).not.toContain(bay.objectId);
      expect(await reselectionTargets(tx, { id: runId, params: { documentVersionIds: [m.versionId], rulesVersion: "v1" } }, today)).toEqual([]);
    }));

  it("an explicit run on a POI re-selects the places within reach of an object merged into it (final review I2)", () =>
    withRollback(async (tx) => {
      const bay = await insertPlace(tx, { lon: LON, lat: LAT, name: "Randbucht" });
      // the dropped twin lies within 20 km of the bay, the survivor just beyond
      const drop = await poi(tx, "Naos", 19.5);
      const keep = await poi(tx, "Naos Afaias", 20.5);
      const direct = { id: newId(), params: { geoObjectIds: [keep] } };
      expect(await reselectionTargets(tx, direct, today)).toEqual([]);
      await mergeGeoObjects(tx, keep, drop);
      expect(await reselectionTargets(tx, direct, today)).toEqual([bay.objectId]);
    }));
});
