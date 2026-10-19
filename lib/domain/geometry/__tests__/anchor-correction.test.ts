import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { facts, places, reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { setAnchorPosition } from "@/lib/domain/geometry/anchor-correction";
import { DecisionNotAllowed } from "@/lib/domain/review-decisions";
import { withRollback } from "@/test/db";
import { insertScenePlace } from "@/test/geometry/scene";
import { lonLatOf } from "@/test/geometry/synthetic";

const NOW = new Date("2026-10-19T09:30:00Z");

async function anchorOf(tx: Db, placeId: string) {
  const { rows } = await tx.execute<{ lon: number | null; lat: number | null; confidence: number | null; origin: string | null }>(sql`
    select ST_X(anchor_position) as lon, ST_Y(anchor_position) as lat, anchor_confidence as confidence, anchor_origin as origin
    from places where id = ${placeId}`);
  return rows[0]!;
}

/** A confirmed scene place with a computed anchor 100 m north of its position. */
async function placeWithComputedAnchor(tx: Db) {
  const place = await insertScenePlace(tx, 0, 100, { status: "confirmed" });
  const computed = await lonLatOf(tx, 0, 200);
  await tx
    .update(places)
    .set({
      anchorPosition: sql`ST_SetSRID(ST_MakePoint(${computed.lon}::float8, ${computed.lat}::float8), 4326)`,
      anchorConfidence: 0.3,
      anchorOrigin: "computed",
    })
    .where(eq(places.id, place.placeId));
  return { ...place, computed };
}

const anchorTasks = (tx: Db, placeId: string) =>
  tx
    .select()
    .from(reviewTasks)
    .where(and(eq(reviewTasks.subjectType, "place_anchor"), eq(reviewTasks.subjectId, placeId)));

describe("setAnchorPosition", () => {
  it("setAnchorPosition writes one decided task, one decision, one review fact (0.9) and updates the place", () =>
    withRollback(async (tx) => {
      const place = await placeWithComputedAnchor(tx);
      const position = await lonLatOf(tx, 40, 300);

      const { factId } = await setAnchorPosition(tx, { placeId: place.placeId, position, decidedBy: "admin@example.org", now: NOW });

      const tasks = await anchorTasks(tx, place.placeId);
      expect(tasks).toHaveLength(1);
      const task = tasks[0]!;
      expect(task.kind).toBe("place_candidate");
      expect(task.status).toBe("decided");
      const context = task.context as { previous: { lon: number; lat: number } | null; previousOrigin: string | null };
      expect(context.previousOrigin).toBe("computed");
      expect(context.previous!.lon).toBeCloseTo(place.computed.lon, 9);
      expect(context.previous!.lat).toBeCloseTo(place.computed.lat, 9);

      const decisions = await tx.select().from(reviewDecisions).where(eq(reviewDecisions.taskId, task.id));
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.decision).toEqual({ action: "set_anchor", position });
      expect(decisions[0]!.decidedBy).toBe("admin@example.org");
      expect(decisions[0]!.decidedAt).toEqual(NOW);

      const written = await tx.select().from(facts).where(eq(facts.geoObjectId, place.geoObjectId));
      expect(written).toHaveLength(1);
      const fact = written[0]!;
      expect(fact.id).toBe(factId);
      expect(fact.attribute).toBe("anchor_position");
      expect(fact.value).toEqual(position);
      expect(fact.reviewDecisionId).toBe(decisions[0]!.id);
      expect(fact.computationId).toBeNull();
      expect(fact.confidence).toBeCloseTo(0.9, 6);
      expect(fact.observedAt).toBe("2026-10-19");

      const anchor = await anchorOf(tx, place.placeId);
      expect(Number(anchor.lon)).toBeCloseTo(position.lon, 9);
      expect(Number(anchor.lat)).toBeCloseTo(position.lat, 9);
      expect(anchor.confidence).toBeCloseTo(0.9, 6);
      expect(anchor.origin).toBe("review");
    }));

  it("a position 3 km away is DecisionNotAllowed and writes nothing", () =>
    withRollback(async (tx) => {
      const place = await placeWithComputedAnchor(tx);
      const position = await lonLatOf(tx, 0, 3100);

      await expect(
        setAnchorPosition(tx, { placeId: place.placeId, position, decidedBy: "admin@example.org", now: NOW }),
      ).rejects.toBeInstanceOf(DecisionNotAllowed);

      expect(await anchorTasks(tx, place.placeId)).toHaveLength(0);
      expect(await tx.select().from(facts).where(eq(facts.geoObjectId, place.geoObjectId))).toHaveLength(0);
      const anchor = await anchorOf(tx, place.placeId);
      expect(Number(anchor.lon)).toBeCloseTo(place.computed.lon, 9);
      expect(Number(anchor.lat)).toBeCloseTo(place.computed.lat, 9);
      expect(anchor.origin).toBe("computed");
    }));

  it("an ended or merged place is DecisionNotAllowed", () =>
    withRollback(async (tx) => {
      const ended = await insertScenePlace(tx, 0, 100, { ended: true });
      await expect(
        setAnchorPosition(tx, { placeId: ended.placeId, position: ended.position, decidedBy: "admin@example.org" }),
      ).rejects.toBeInstanceOf(DecisionNotAllowed);
    }));
});
