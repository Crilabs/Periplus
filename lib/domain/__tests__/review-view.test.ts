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
import { listOpenTasks, nextTaskHref, reviewCounts, reviewTaskDetail } from "@/lib/domain/review-view";
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

  it("reviewTaskDetail shows a source proposal with hits, link graph, languages, robots and suggestion", () =>
    withRollback(async (tx) => {
      const insertSource = async () => {
        const domain = `${newId()}.test.invalid`;
        const [row] = await tx
          .insert(sources)
          .values({
            domain,
            name: domain,
            type: "trip_report",
            weight: 0.6,
            crawlRules: DEFAULT_CRAWL_RULES,
            languages: ["en", "de"],
            origin: "serp",
          })
          .returning({ id: sources.id });
        return { id: row!.id, domain };
      };
      const source = await insertSource();
      const domain = source.domain;
      const hit = {
        url: `https://${domain}/blog/a`,
        keyword: "hydra anchorage",
        languageCode: "en",
        rank: 3,
        title: "Hydra",
        snippet: "Anchoring off Hydra",
      };
      const robots = { status: "parsed", disallowAll: false, blockedStartUrls: [], crawlDelaySec: 5, sitemaps: 1 };
      const suggestion = {
        type: "pilot_guide",
        weight: 0.9,
        changeRate: "static",
        crawlRules: { ...DEFAULT_CRAWL_RULES, allow: ["^/blog/"] },
      };
      const { id } = await createReviewTask(tx, {
        kind: "source_approval",
        subjectType: "source",
        subjectId: source.id,
        context: { hits: [hit], hitCount: 14, linkingSources: 2, languages: ["en", "de"], robots, suggestion },
      });

      const detail = await reviewTaskDetail(tx, id);
      expect(detail?.subject).toMatchObject({
        type: "source",
        source: { id: source.id, domain, status: "proposed" },
        hits: [hit],
        hitCount: 14,
        linkingSources: 2,
        languages: ["en", "de"],
        robots,
        // The form defaults are the source's current values; the proposal's own suggestion stays visible (UI-1).
        suggestion: { type: "trip_report", weight: 0.6, changeRate: "normal", crawlRules: DEFAULT_CRAWL_RULES },
        originalSuggestion: suggestion,
        editedSinceProposal: true,
      });

      // Without (valid) context the suggestion is the source's current values and there is no original.
      const { id: bare } = await createReviewTask(tx, {
        kind: "source_approval",
        subjectType: "source",
        subjectId: (await insertSource()).id,
        context: { hits: "nope" },
      });
      expect((await reviewTaskDetail(tx, bare))?.subject).toMatchObject({
        type: "source",
        hits: [],
        hitCount: 0,
        linkingSources: 0,
        robots: null,
        suggestion: { type: "trip_report", weight: 0.6, changeRate: "normal", crawlRules: DEFAULT_CRAWL_RULES },
        originalSuggestion: null,
        editedSinceProposal: false,
      });
    }));

  it("reviewTaskDetail of a source task whose source does not exist is missing", () =>
    withRollback(async (tx) => {
      const { id } = await createReviewTask(tx, {
        kind: "source_approval",
        subjectType: "source",
        subjectId: newId(),
        context: {},
      });
      expect((await reviewTaskDetail(tx, id))?.subject).toEqual({ type: "missing" });
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
      expect(first.map((t) => t.evaluation)).toEqual([false, false]);

      // a deviation of an evaluation run is marked as such in the queue
      const evaluation = await createReviewTask(tx, {
        kind: "comparison_deviation",
        subjectType: "place",
        subjectId: `${a}:evaluation`,
        context: { name: "A", evaluationRunId: crypto.randomUUID() },
        priority: 2_000_000_002,
      });
      const marked = await listOpenTasks(tx, { kind: "comparison_deviation", limit: 1 });
      expect(marked.map((t) => [t.id, t.evaluation])).toEqual([[evaluation.id, true]]);
    }, { isolationLevel: "repeatable read" }));

  it("the list names each task's subject: domain, place, object with attribute, pair, queue; the evaluation filter splits deviations (UI-6)", () =>
    withRollback(async (tx) => {
      const domain = `${newId()}.test.invalid`;
      const [source] = await tx
        .insert(sources)
        .values({ domain, name: domain, type: "trip_report", weight: 0.6, crawlRules: DEFAULT_CRAWL_RULES, origin: "serp" })
        .returning({ id: sources.id });
      const placeId = await insertPlace(tx, "Listed Bay", 0.03);
      const otherId = await insertPlace(tx, "Other Bay", 0.031);
      const object = async (id: string) => (await tx.select({ g: places.geoObjectId }).from(places).where(sql`id = ${id}`))[0]!.g;
      const [g1, g2] = [await object(placeId), await object(otherId)].sort();
      const top = 2_100_000_000;
      const task = (kind: (typeof reviewKindEnum.enumValues)[number], subjectType: string, subjectId: string, context: Record<string, unknown>, n: number) =>
        createReviewTask(tx, { kind, subjectType, subjectId, context, priority: top - n });
      const ids = [
        (await task("source_approval", "source", source!.id, {}, 0)).id,
        (await task("conflict", "profile_attribute", `${await object(placeId)}:seabed`, { key: "k" }, 1)).id,
        (await task("place_candidate", "place", placeId, { reason: "restricted" }, 2)).id,
        (await task("place_candidate", "geo_object_pair", `${g1}:${g2}`, {}, 3)).id,
        (await task("failed_job", "job", newId(), { queue: "fetch.url" }, 4)).id,
        (await task("comparison_deviation", "comparison", `${placeId}:depth:x`, { placeId, attribute: "depth" }, 5)).id,
        (await task("comparison_deviation", "comparison", `${placeId}:depth:y`, { placeId, attribute: "depth", evaluationRunId: newId() }, 6)).id,
      ];
      const rows = await listOpenTasks(tx, { limit: ids.length });
      expect(rows.map((r) => r.id)).toEqual(ids);
      const pair = [g1, g2].map((g) => (g === (rows[1]!.subjectId.slice(0, 36)) ? "Listed Bay" : "Other Bay")).join(" / ");
      expect(rows.map((r) => [r.name, r.attribute, r.evaluation])).toEqual([
        [domain, null, false],
        ["Listed Bay", "Grund", false],
        ["Listed Bay", null, false],
        [pair, null, false],
        ["fetch.url", null, false],
        ["Listed Bay", "depth", false],
        ["Listed Bay", "depth", true],
      ]);

      const regular = await listOpenTasks(tx, { kind: "comparison_deviation", evaluation: "none", limit: 1 });
      expect(regular.map((r) => r.id)).toEqual([ids[5]]);
      const evaluationOnly = await listOpenTasks(tx, { kind: "comparison_deviation", evaluation: "only", limit: 1 });
      expect(evaluationOnly.map((r) => r.id)).toEqual([ids[6]]);
      // „Nächste“ after a regular deviation skips the evaluation deviation behind it
      const afterRegular = await nextTaskHref(tx, ids[5]!);
      expect(afterRegular).not.toBe(`/review/${ids[6]}`);
    }, { isolationLevel: "repeatable read" }));
});
