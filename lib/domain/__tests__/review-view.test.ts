import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  geoNames,
  geoObjects,
  places,
  restrictedAreas,
  reviewDecisions,
  reviewKindEnum,
  sources,
  type PlaceStatus,
} from "@/lib/db/schema";
import { setAnchorPosition } from "@/lib/domain/geometry/anchor-correction";
import { applyExclusion } from "@/lib/domain/geometry/restrictions";
import { newId } from "@/lib/domain/ids";
import { createReviewTask } from "@/lib/domain/review";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import { listOpenTasks, nextTaskHref, reviewCounts, reviewTaskDetail, reviewTaskTitle } from "@/lib/domain/review-view";
import { placeTitle } from "@/lib/domain/geo-view";
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

  it("a restricted-area review of a confirmed place shows the reason and every area with kind, reference and source (UI-4, GR-5)", () =>
    withRollback(async (tx) => {
      const placeId = await insertPlace(tx, "Kept Bay", 0.02, "confirmed");
      const [source] = await tx
        .insert(sources)
        .values({ domain: `${newId()}.test.invalid`, name: "EMODnet Human Activities", type: "authority", weight: 0.9, crawlRules: DEFAULT_CRAWL_RULES, origin: "manual" })
        .returning({ id: sources.id });
      const area = (kind: "military" | "protected_area", sourceRef: string) =>
        tx
          .insert(restrictedAreas)
          .values({ kind, sourceRef, sourceId: source!.id, geom: sql`${geomFromGeoJson(point(LON + 0.02, LAT))}` })
          .returning({ id: restrictedAreas.id })
          .then((r) => r[0]!.id);
      const firing = await area("military", "emodnet/military/X1");
      const natura = await area("protected_area", "emodnet/natura/GR0001");
      await applyExclusion(tx, placeId, [
        { restrictedAreaId: firing, kind: "military", sourceRef: "emodnet/military/X1", share: 1, anchoringBan: true },
        { restrictedAreaId: natura, kind: "protected_area", sourceRef: "emodnet/natura/GR0001", share: 0.6, anchoringBan: true },
      ]);
      const { rows } = await tx.execute<{ id: string }>(sql`select id from review_tasks where subject_id = ${placeId} and status = 'open'`);
      const task = rows[0];
      const detail = await reviewTaskDetail(tx, task!.id);
      expect(detail?.subject).toMatchObject({
        type: "place",
        restrictions: [
          { id: firing, kind: "military", sourceRef: "emodnet/military/X1", sourceName: "EMODnet Human Activities", share: 1 },
          { id: natura, kind: "protected_area", sourceRef: "emodnet/natura/GR0001", sourceName: "EMODnet Human Activities", share: 0.6 },
        ],
      });
      // any other place task has none
      const { id: other } = await createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId: await insertPlace(tx, "Other Bay", 0.03), context: {} });
      expect((await reviewTaskDetail(tx, other))?.subject).toMatchObject({ type: "place", restrictions: null });
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

  it("the list names each task's subject: place, pair, queue, comparison attribute (UI-6)", () =>
    withRollback(async (tx) => {
      const placeId = await insertPlace(tx, "Listed Bay", 0.03);
      const otherId = await insertPlace(tx, "Other Bay", 0.031);
      const object = async (id: string) => (await tx.select({ g: places.geoObjectId }).from(places).where(sql`id = ${id}`))[0]!.g;
      const [g1, g2] = [await object(placeId), await object(otherId)].sort();
      const top = 2_100_000_000;
      const task = (kind: (typeof reviewKindEnum.enumValues)[number], subjectType: string, subjectId: string, context: Record<string, unknown>, n: number) =>
        createReviewTask(tx, { kind, subjectType, subjectId, context, priority: top - n });
      const ids = [
        (await task("place_candidate", "place", placeId, { reason: "restricted" }, 0)).id,
        (await task("place_candidate", "geo_object_pair", `${g1}:${g2}`, {}, 1)).id,
        (await task("failed_job", "job", newId(), { queue: "research.fetch" }, 2)).id,
        (await task("comparison_deviation", "comparison", `${placeId}:depth:x`, { placeId, attribute: "depth" }, 3)).id,
      ];
      const rows = await listOpenTasks(tx, { limit: ids.length });
      expect(rows.map((r) => r.id)).toEqual(ids);
      const pair = [g1, g2].map((g) => (g === (rows[1]!.subjectId.slice(0, 36)) ? "Listed Bay" : "Other Bay")).join(" / ");
      expect(rows.map((r) => [r.name, r.attribute])).toEqual([
        ["Listed Bay", null],
        [pair, null],
        ["research.fetch", null],
        ["Listed Bay", "depth"],
      ]);
      // „Nächste“ after the last task of its kind goes back to the list
      expect(await nextTaskHref(tx, ids[3]!)).not.toBe(`/review/${ids[0]}`);
    }, { isolationLevel: "repeatable read" }));

  it("a task's and a place's page titles name the subject (UI-15)", () =>
    withRollback(async (tx) => {
      const placeId = await insertPlace(tx, "Title Bay", 0.04);
      const { id } = await createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId: placeId, context: {} });
      expect(await reviewTaskTitle(tx, id)).toEqual({ kind: "place_candidate", name: "Title Bay" });
      expect(await reviewTaskTitle(tx, "nope")).toBeNull();
      expect(await placeTitle(tx, placeId)).toBe("Title Bay");
      expect(await placeTitle(tx, "nope")).toBeNull();
    }));
});
