import { and, eq, isNull, sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { facts, places, reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { validateFactValue } from "@/lib/domain/facts/schema";
import { DecisionNotAllowed } from "@/lib/domain/review-decisions";
import { validAt } from "@/lib/domain/timeline";
import type { LonLat } from "./water";

const pointSql = (p: LonLat) => sql`ST_SetSRID(ST_MakePoint(${p.lon}::float8, ${p.lat}::float8), 4326)`;

/**
 * An admin's anchor position for a place, in one transaction (spec 04: admin correction = review fact). Writes an
 * immediately decided `place_candidate` task on subject `place_anchor` (context: the previous anchor and its
 * origin), one `review_decisions` row `{ action: "set_anchor", position }`, the fact `anchor_position` on that
 * decision (confidence `correctionConfidence`, observed on `now`'s date) and the place's anchor (origin `review`,
 * which the geometry stage never overwrites). `DecisionNotAllowed` when the place is not valid (unknown, ended,
 * merged) or the position lies more than `correctionMaxDistanceM` from the place position; nothing is written then.
 */
export async function setAnchorPosition(
  db: Db,
  input: { placeId: string; position: LonLat; decidedBy: string; now?: Date },
): Promise<{ factId: string }> {
  const config = getConfig();
  const { correctionConfidence, correctionMaxDistanceM } = config.geometry.anchorArea;
  const factSchemaVersion = config.factSchema.version;
  const position = validateFactValue("anchor_position", input.position, factSchemaVersion) as LonLat;
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [place] = await tx
      .select({
        geoObjectId: places.geoObjectId,
        anchorLon: sql<number | null>`ST_X(${places.anchorPosition})`,
        anchorLat: sql<number | null>`ST_Y(${places.anchorPosition})`,
        anchorOrigin: places.anchorOrigin,
        distanceM: sql<number>`ST_Distance(${places.position}::geography, (${pointSql(position)})::geography)`,
      })
      .from(places)
      .where(and(eq(places.id, input.placeId), validAt(places), isNull(places.mergedIntoId)))
      .for("update");
    if (!place) throw new DecisionNotAllowed(`place ${input.placeId} is not valid`);
    if (Number(place.distanceM) > correctionMaxDistanceM) {
      throw new DecisionNotAllowed(
        `anchor position ${Math.round(Number(place.distanceM))} m from place ${input.placeId} (max ${correctionMaxDistanceM} m)`,
      );
    }

    const previous =
      place.anchorLon === null || place.anchorLat === null
        ? null
        : { lon: Number(place.anchorLon), lat: Number(place.anchorLat) };
    const [task] = await tx
      .insert(reviewTasks)
      .values({
        kind: "place_candidate",
        subjectType: "place_anchor",
        subjectId: input.placeId,
        context: { previous, previousOrigin: place.anchorOrigin },
        status: "decided",
      })
      .returning({ id: reviewTasks.id });
    const [decision] = await tx
      .insert(reviewDecisions)
      .values({
        taskId: task!.id,
        decision: { action: "set_anchor", position },
        decidedBy: input.decidedBy,
        decidedAt: now,
      })
      .returning({ id: reviewDecisions.id });
    const [fact] = await tx
      .insert(facts)
      .values({
        geoObjectId: place.geoObjectId,
        attribute: "anchor_position",
        value: position,
        reviewDecisionId: decision!.id,
        observedAt: now.toISOString().slice(0, 10),
        confidence: correctionConfidence,
        factSchemaVersion,
      })
      .returning({ id: facts.id });
    await tx
      .update(places)
      .set({ anchorPosition: sql`${pointSql(position)}`, anchorConfidence: correctionConfidence, anchorOrigin: "review" })
      .where(eq(places.id, input.placeId));
    return { factId: fact!.id };
  });
}
