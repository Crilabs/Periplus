import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, places, reviewDecisions, reviewKindEnum, type PlaceStatus } from "@/lib/db/schema";
import { setAnchorPosition } from "@/lib/domain/geometry/anchor-correction";
import { createReviewTask } from "@/lib/domain/review";
import { listOpenTasks, reviewCounts, reviewTaskDetail } from "@/lib/domain/review-view";
import { withRollback } from "@/test/db";

// Synthetic data in open sea outside the pilot box 23.0-23.75 E x 37.0-38.0 N, at a spot no other test uses.
const LON = 26.31;
const LAT = 34.31;
const point = (lon: number, lat: number): GeoJSON.Point => ({
  type: "Point",
  coordinates: [lon, lat],
});

async function insertPlace(tx: Db, name: string, dLon: number, status: PlaceStatus = "candidate"): Promise<string> {
  const geom = sql`${geomFromGeoJson(point(LON + dLon, LAT))}`;
  const [object] = await tx
    .insert(geoObjects)
    .values({ type: "bay", origin: "geonames", geom })
    .returning({ id: geoObjects.id });
  await tx.insert(geoNames).values({
    geoObjectId: object!.id,
    name,
    nameNormalized: name.toLowerCase(),
    language: "en",
    script: "latin",
    origin: "geonames",
  });
  const [place] = await tx
    .insert(places)
    .values({
      geoObjectId: object!.id,
      kind: "anchorage",
      status,
      position: geom,
    })
    .returning({ id: places.id });
  return place!.id;
}

describe("review view", () => {
  it("reviewTaskDetail lists the 5 nearest places for a candidate", () =>
    withRollback(async (tx) => {
      const subject = await insertPlace(tx, "Subject Bay", 0);
      // 7 valid neighbours, ~90 m apart each, plus a rejected one that is closest and must be left out.
      const neighbours: string[] = [];
      for (let i = 1; i <= 7; i++) neighbours.push(await insertPlace(tx, `Neighbour ${i}`, i * 0.001));
      await insertPlace(tx, "Rejected", 0.0005, "rejected");
      const { id } = await createReviewTask(tx, {
        kind: "place_candidate",
        subjectType: "place",
        subjectId: subject,
        context: { name: "Subject Bay" },
        priority: 1_000_000_007,
      });

      const detail = await reviewTaskDetail(tx, id);
      expect(detail?.task).toMatchObject({
        id,
        kind: "place_candidate",
        status: "open",
      });
      if (detail?.subject.type !== "place") throw new Error("expected a place subject");
      expect(detail.subject.place).toMatchObject({
        id: subject,
        kind: "anchorage",
        status: "candidate",
      });
      expect(detail.subject.place.position.lon).toBeCloseTo(LON, 6);
      expect(detail.subject.geoObject.names).toEqual([{ name: "Subject Bay", language: "en", origin: "geonames" }]);
      expect(detail.subject.nearby.map((n) => n.id)).toEqual(neighbours.slice(0, 5));
      expect(detail.subject.nearby.map((n) => n.name)).toEqual([1, 2, 3, 4, 5].map((i) => `Neighbour ${i}`));
      const distances = detail.subject.nearby.map((n) => n.distanceM);
      expect(distances[0]).toBeGreaterThan(80);
      expect(distances[0]).toBeLessThan(100);
      expect([...distances].sort((a, b) => a - b)).toEqual(distances);

      expect(await reviewTaskDetail(tx, "0190a6c2-7a1b-7c3d-8e4f-0123456789ab")).toBeNull();
    }));

  it("reviewTaskDetail renders a decided place_anchor task from an anchor correction without error", () =>
    withRollback(async (tx) => {
      const placeId = await insertPlace(tx, "Anchor Bay", 0, "confirmed");
      await setAnchorPosition(tx, { placeId, position: { lon: LON + 0.0005, lat: LAT }, decidedBy: "admin@example.org" });
      const { rows } = await tx.execute<{ id: string }>(sql`
        select id from review_tasks where subject_type = 'place_anchor' and subject_id = ${placeId}`);
      expect(rows).toHaveLength(1);

      const detail = await reviewTaskDetail(tx, rows[0]!.id);
      expect(detail?.task).toMatchObject({ kind: "place_candidate", status: "decided", subjectType: "place_anchor" });
      expect(detail?.subject).toEqual({ type: "missing" });
      expect(await tx.select().from(reviewDecisions)).not.toHaveLength(0);
    }));

  // A kind no pipeline code creates yet, so concurrent test files cannot change its count.
  // Repeatable read: the per-kind counts are database-wide, other test files commit tasks meanwhile.
  it("lists open tasks in queue order and counts them per kind", () =>
    withRollback(async (tx) => {
      const before = await reviewCounts(tx);
      const a = await insertPlace(tx, "A", 0);
      const b = await insertPlace(tx, "B", 0.01);
      const task = (subjectId: string, name: string, priority: number) =>
        createReviewTask(tx, {
          kind: "comparison_deviation",
          subjectType: "place",
          subjectId,
          context: { name },
          priority,
        });
      const low = await task(a, "A", 2_000_000_000);
      const high = await task(b, "B", 2_000_000_001);

      const counts = await reviewCounts(tx);
      expect(Object.keys(counts).sort()).toEqual([...reviewKindEnum.enumValues].sort());
      expect(counts.comparison_deviation).toBe(before.comparison_deviation + 2);

      const first = await listOpenTasks(tx, {
        kind: "comparison_deviation",
        limit: 2,
      });
      expect(first.map((t) => [t.id, t.name])).toEqual([
        [high.id, "B"],
        [low.id, "A"],
      ]);
      const next = await listOpenTasks(tx, {
        kind: "comparison_deviation",
        limit: 1,
        before: high.id,
      });
      expect(next.map((t) => t.id)).toEqual([low.id]);
    }, { isolationLevel: "repeatable read" }));
});
