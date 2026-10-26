import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places, reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { DecisionNotAllowed } from "@/lib/domain/review-decisions";
import { validAt } from "@/lib/db/valid-at";
import type { LonLat } from "./water";

const pointSql = (p: LonLat) => sql`ST_SetSRID(ST_MakePoint(${p.lon}::float8, ${p.lat}::float8), 4326)`;
const positionSchema = z.object({ lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) });

/**
 * „Position korrigieren“ (ruling M6-H-R1, the remedy of a package blocked by `spot_location`, which checks the place
 * point delivered as `spot.position`): an admin's position for a valid, unmerged place, in one transaction. Writes an
 * immediately decided `place_candidate` task on subject `place_position` (context: the previous position), one
 * `review_decisions` row `{ action: "set_position", position }` and the place's position (the triggers move its tile
 * and record the history). A correction moves the point at most `geometry.anchorArea.correctionMaxDistanceM` (the same
 * limit as an anchor correction); further, or for a place that is not valid, `DecisionNotAllowed` and nothing is
 * written. Geometry and profile follow with a run the caller starts after the commit.
 */
export async function setPlacePosition(
  db: Db,
  input: { placeId: string; position: LonLat; decidedBy: string; now?: Date },
): Promise<{ geoObjectId: string; previous: LonLat }> {
  const position = positionSchema.parse(input.position);
  const maxM = getConfig().geometry.anchorArea.correctionMaxDistanceM;
  return db.transaction(async (tx) => {
    const [place] = await tx
      .select({
        geoObjectId: places.geoObjectId,
        lon: sql<number>`ST_X(${places.position})`,
        lat: sql<number>`ST_Y(${places.position})`,
        distanceM: sql<number>`ST_Distance(${places.position}::geography, (${pointSql(position)})::geography)`,
      })
      .from(places)
      .where(and(eq(places.id, input.placeId), validAt(places), isNull(places.mergedIntoId)))
      .for("update");
    if (!place) throw new DecisionNotAllowed(`place ${input.placeId} is not valid`);
    if (Number(place.distanceM) > maxM) {
      throw new DecisionNotAllowed(`position ${Math.round(Number(place.distanceM))} m from place ${input.placeId} (max ${maxM} m)`);
    }
    const previous = { lon: Number(place.lon), lat: Number(place.lat) };
    const [task] = await tx
      .insert(reviewTasks)
      .values({ kind: "place_candidate", subjectType: "place_position", subjectId: input.placeId, context: { previous }, status: "decided" })
      .returning({ id: reviewTasks.id });
    await tx.insert(reviewDecisions).values({
      taskId: task!.id,
      decision: { action: "set_position", position },
      decidedBy: input.decidedBy,
      decidedAt: input.now ?? new Date(),
    });
    await tx.update(places).set({ position: sql`${pointSql(position)}` }).where(eq(places.id, input.placeId));
    return { geoObjectId: place.geoObjectId, previous };
  });
}
