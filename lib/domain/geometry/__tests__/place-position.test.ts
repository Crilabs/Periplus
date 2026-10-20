import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { places, reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { setPlacePosition } from "@/lib/domain/geometry/place-position";
import { DecisionNotAllowed } from "@/lib/domain/review-decisions";
import { tileIdFor } from "@/lib/domain/tiles";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";

/*
 * „Position korrigieren“ (ruling M6-H-R1): the place point an admin sets, the remedy for `spot_location`. withRollback
 * on the synthetic grid around 21.0° E / 35.2° N.
 */

async function placeRow(tx: Db, placeId: string) {
  const { rows } = await tx.execute<{ lon: number; lat: number; tile_id: string | null }>(
    sql`select ST_X(position) as lon, ST_Y(position) as lat, tile_id from places where id = ${placeId}`,
  );
  return rows[0]!;
}

describe("setPlacePosition", () => {
  it("moves the place point with one decided task and decision; the tile follows the point", () =>
    withRollback(async (tx) => {
      const { objectId, placeId } = await insertPlace(tx, { lon: 21.0, lat: 35.2 });
      // 0.004° west: into the tile west of 21.0 (an edge belongs to the tile east of it)
      const position = { lon: 20.996, lat: 35.2 };
      const result = await setPlacePosition(tx, { placeId, position, decidedBy: "admin@example.invalid" });
      expect(result).toEqual({ geoObjectId: objectId, previous: { lon: 21.0, lat: 35.2 } });
      const row = await placeRow(tx, placeId);
      expect({ lon: Number(row.lon), lat: Number(row.lat) }).toEqual(position);
      expect(row.tile_id).toBe(tileIdFor(20.996, 35.2));
      const [task] = await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, placeId));
      expect(task).toMatchObject({ kind: "place_candidate", subjectType: "place_position", status: "decided", context: { previous: { lon: 21.0, lat: 35.2 } } });
      const [decision] = await tx.select().from(reviewDecisions).where(eq(reviewDecisions.taskId, task!.id));
      expect(decision).toMatchObject({ decision: { action: "set_position", position }, decidedBy: "admin@example.invalid" });
    }));

  it("a point further than the correction limit, or an ended or merged place, is DecisionNotAllowed and writes nothing", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx, { lon: 21.0, lat: 35.2 });
      // 0.03° of latitude ≈ 3.3 km, beyond the 2000 m limit
      await expect(setPlacePosition(tx, { placeId, position: { lon: 21.0, lat: 35.23 }, decidedBy: "a" })).rejects.toBeInstanceOf(DecisionNotAllowed);
      expect(Number((await placeRow(tx, placeId)).lat)).toBe(35.2);
      expect(await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, placeId))).toEqual([]);

      const other = await insertPlace(tx, { lon: 21.01, lat: 35.2, name: "Andere" });
      await tx.update(places).set({ mergedIntoId: other.placeId }).where(eq(places.id, placeId));
      await expect(setPlacePosition(tx, { placeId, position: { lon: 21.0, lat: 35.201 }, decidedBy: "a" })).rejects.toBeInstanceOf(DecisionNotAllowed);
      await tx.execute(sql`update places set valid_to = current_date where id = ${other.placeId}`);
      await expect(setPlacePosition(tx, { placeId: other.placeId, position: { lon: 21.01, lat: 35.201 }, decidedBy: "a" })).rejects.toBeInstanceOf(
        DecisionNotAllowed,
      );
    }));
});
