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

  it("a place without a previous anchor records previous null and no origin", () =>
    withRollback(async (tx) => {
      const place = await insertScenePlace(tx, 0, 100, { status: "confirmed" });
      const position = await lonLatOf(tx, 20, 150);

      await setAnchorPosition(tx, { placeId: place.placeId, position, decidedBy: "admin@example.org", now: NOW });

      const [task] = await anchorTasks(tx, place.placeId);
      expect(task!.context).toEqual({ previous: null, previousOrigin: null });
      expect(await anchorOf(tx, place.placeId)).toMatchObject({ confidence: 0.9, origin: "review" });
    }));

  it("accepts a position just inside 2000 m and rejects one just outside", () =>
    withRollback(async (tx) => {
      const place = await insertScenePlace(tx, 0, 100, { status: "confirmed" });
      const at = async (distanceM: number) => {
        const { rows } = await tx.execute<{ lon: number; lat: number }>(sql`
          select ST_X(p) as lon, ST_Y(p) as lat
          from (select ST_Project(position::geography, ${distanceM}::float8, radians(90))::geometry as p from places where id = ${place.placeId}) t`);
        return { lon: Number(rows[0]!.lon), lat: Number(rows[0]!.lat) };
      };

      await expect(
        setAnchorPosition(tx, { placeId: place.placeId, position: await at(2000.5), decidedBy: "admin@example.org", now: NOW }),
      ).rejects.toBeInstanceOf(DecisionNotAllowed);
      expect(await anchorTasks(tx, place.placeId)).toHaveLength(0);

      await setAnchorPosition(tx, { placeId: place.placeId, position: await at(1999.5), decidedBy: "admin@example.org", now: NOW });
      expect(await anchorTasks(tx, place.placeId)).toHaveLength(1);
    }));

  it("a second correction on a place already at origin review keeps both decisions and the latest anchor", () =>
    withRollback(async (tx) => {
      const place = await placeWithComputedAnchor(tx);
      const first = await lonLatOf(tx, 40, 300);
      const second = await lonLatOf(tx, -60, 400);

      const a = await setAnchorPosition(tx, { placeId: place.placeId, position: first, decidedBy: "a@example.org", now: NOW });
      const b = await setAnchorPosition(tx, { placeId: place.placeId, position: second, decidedBy: "b@example.org", now: NOW });
      expect(b.factId).not.toBe(a.factId);

      const tasks = await anchorTasks(tx, place.placeId);
      expect(tasks).toHaveLength(2);
      const contexts = tasks.map((t) => t.context as { previous: { lon: number; lat: number } | null; previousOrigin: string | null });
      const latest = contexts.find((c) => c.previousOrigin === "review")!;
      expect(latest.previous!.lon).toBeCloseTo(first.lon, 9);
      expect(latest.previous!.lat).toBeCloseTo(first.lat, 9);
      expect(contexts.some((c) => c.previousOrigin === "computed")).toBe(true);
      expect(await tx.select().from(facts).where(eq(facts.geoObjectId, place.geoObjectId))).toHaveLength(2);

      const anchor = await anchorOf(tx, place.placeId);
      expect(Number(anchor.lon)).toBeCloseTo(second.lon, 9);
      expect(Number(anchor.lat)).toBeCloseTo(second.lat, 9);
      expect(anchor.origin).toBe("review");
    }));
});
