import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { tileGeoObjects } from "@/lib/db/schema";
import { consolidationTargets } from "@/lib/domain/consolidation/targets";
import { newId } from "@/lib/domain/ids";
import { tileIdFor } from "@/lib/domain/tiles";
import { insertMention, insertPlace, insertSource } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";
import { insertNamedObject, insertTestRun, insertTestTile } from "@/test/text";

/*
 * POI targets of a run become the places within the largest highlight reach (spec 16): a POI's importance changes
 * the selection of those places, so they are consolidated again in the same run; the POIs leave the geo stage. Objects
 * on a synthetic spot far from the pilot box and the other tests' objects.
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
  it("a text run with a mention on a POI targets the places within 20 km, not the POI", () =>
    withRollback(async (tx) => {
      const near = await insertPlace(tx, { lon: LON, lat: LAT, name: "Nahbucht" });
      const far = await insertPlace(tx, { lon: LON, lat: LAT - 10 * LAT_PER_KM, name: "Fernbucht" });
      const candidate = await insertPlace(tx, { lon: LON, lat: LAT + 30 * LAT_PER_KM, name: "Kandidatenbucht", status: "candidate" });
      const rejected = await insertPlace(tx, { lon: LON, lat: LAT + 20 * LAT_PER_KM, name: "Abgelehnt", status: "rejected" });
      // the POI lies 15 km from `near`, 25 km from `far`, 15 km from the candidate
      const castle = await poi(tx, "Kastro", 15);
      const runId = await insertTestRun(tx);
      const m = await insertMention(tx, castle, { sourceId: await insertSource(tx), runId });
      const targets = await consolidationTargets(tx, { id: runId, params: { documentVersionIds: [m.versionId] } }, today);
      expect(targets).toEqual([near.objectId, candidate.objectId].sort());
      expect(targets).not.toContain(castle);
      expect(targets).not.toContain(far.objectId);
      expect(targets).not.toContain(rejected.objectId);
    }));

  it("a tile run excludes POIs", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, TILE);
      const bay = await insertPlace(tx, { lon: LON, lat: LAT, name: "Kachelbucht" });
      const beach = await poi(tx, "Strand", 1);
      for (const id of [bay.objectId, beach]) await tx.insert(tileGeoObjects).values({ tileId: TILE, geoObjectId: id });
      expect(await consolidationTargets(tx, { id: newId(), params: { tileId: TILE } }, today)).toEqual([bay.objectId]);
    }));

  it("explicit geoObjectIds stay exactly the given objects, POIs included; rules without highlights keep POI targets", () =>
    withRollback(async (tx) => {
      const bay = await insertPlace(tx, { lon: LON, lat: LAT, name: "Direktbucht" });
      const castle = await poi(tx, "Kastro", 2);
      expect(await consolidationTargets(tx, { id: newId(), params: { geoObjectIds: [castle] } }, today)).toEqual([castle]);
      const runId = await insertTestRun(tx);
      const m = await insertMention(tx, castle, { sourceId: await insertSource(tx), runId });
      const v1 = await consolidationTargets(tx, { id: runId, params: { documentVersionIds: [m.versionId], rulesVersion: "v1" } }, today);
      expect(v1).toEqual([castle]);
      expect(v1).not.toContain(bay.objectId);
    }));
});
