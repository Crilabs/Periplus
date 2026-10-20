import { and, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  changeEvents,
  documentVersions,
  facts,
  profiles,
  geoNames,
  geoObjects,
  nameCandidates,
  places,
  tileGeoObjects,
  unmatchedNames,
  reviewDecisions,
  reviewTasks,
  serpQueries,
  serpResults,
  sources,
  tiles,
  type GeoObjectType,
  type PlaceStatus,
  type SourceStatus,
} from "@/lib/db/schema";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { domainCandidates } from "@/lib/domain/discovery/proposals";
import { isPublicId, newId } from "@/lib/domain/ids";
import { createReviewTask } from "@/lib/domain/review";
import {
  DecisionNotAllowed,
  decideReviewTask,
  nextOpenTask,
  reviewDecisionSchema,
  sourceSettingsKey,
  TaskContextChanged,
  valueFingerprint,
  TaskNotOpen,
  type ReviewDecision,
} from "@/lib/domain/review-decisions";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import { getSource } from "@/lib/domain/sources/store";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { getConfig } from "@/lib/config";
import { insertComputation, insertPlace as insertProfilePlace, insertSource as insertProfileSource, insertTextFact } from "@/test/consolidation";
import { startWhileLocked, testDb, withRollback } from "@/test/db";
import { insertNamedObject, insertTestSource, insertTestVersion } from "@/test/text";

// `config/mentions.json` neighbourRing as the test switch sets it (undefined: as configured).
const RING = vi.hoisted(() => ({ value: undefined as 1 | 2 | undefined }));
vi.mock("@/lib/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...original,
    getConfig: () => {
      const cfg = original.getConfig();
      return RING.value ? { ...cfg, mentions: { ...cfg.mentions, neighbourRing: RING.value } } : cfg;
    },
  };
});

// Synthetic data in open sea outside the pilot box 23.0-23.75 E x 37.0-38.0 N (around 28.1 E, 35.1 N).
const LON = 28.1;
const LAT = 35.1;
const point = (lon: number, lat: number): GeoJSON.Point => ({ type: "Point", coordinates: [lon, lat] });

const db = testDb();
const ADMIN = "admin@example.invalid";

async function insertObject(
  tx: Db,
  o: { type?: GeoObjectType; osmId?: string; lon?: number; lat?: number; name?: string } = {},
): Promise<string> {
  const [row] = await tx
    .insert(geoObjects)
    .values({
      type: o.type ?? "bay",
      origin: o.osmId ? "osm" : "geonames",
      osmId: o.osmId,
      geom: sql`${geomFromGeoJson(point(o.lon ?? LON, o.lat ?? LAT))}`,
    })
    .returning({ id: geoObjects.id });
  if (o.name) {
    await tx.insert(geoNames).values({
      geoObjectId: row!.id,
      name: o.name,
      nameNormalized: o.name.toLowerCase(),
      language: "en",
      script: "latin",
      origin: o.osmId ? "osm" : "geonames",
    });
  }
  return row!.id;
}

async function insertPlace(tx: Db, o: { status?: PlaceStatus; lon?: number; lat?: number } = {}) {
  const geoObjectId = await insertObject(tx, { lon: o.lon, lat: o.lat });
  const [row] = await tx
    .insert(places)
    .values({
      geoObjectId,
      kind: "anchorage",
      status: o.status ?? "candidate",
      position: sql`${geomFromGeoJson(point(o.lon ?? LON, o.lat ?? LAT))}`,
    })
    .returning({ id: places.id });
  return { id: row!.id, geoObjectId };
}

async function placeTask(tx: Db, placeId: string): Promise<string> {
  const { id } = await createReviewTask(tx, {
    kind: "place_candidate",
    subjectType: "place",
    subjectId: placeId,
    context: {},
  });
  return id;
}

async function placeOf(tx: Db, id: string) {
  const [row] = await tx
    .select({
      kind: places.kind,
      status: places.status,
      statusReason: places.statusReason,
      publicId: places.publicId,
      mergedIntoId: places.mergedIntoId,
      tileId: places.tileId,
      lon: sql<number>`ST_X(${places.position})`,
      lat: sql<number>`ST_Y(${places.position})`,
    })
    .from(places)
    .where(eq(places.id, id));
  return row!;
}

async function taskOf(tx: Db, id: string) {
  const [row] = await tx.select().from(reviewTasks).where(eq(reviewTasks.id, id));
  return row!;
}

async function decisionsOf(tx: Db, taskId: string) {
  return tx.select().from(reviewDecisions).where(eq(reviewDecisions.taskId, taskId));
}

async function ensureTile(tx: Db, lon: number, lat: number): Promise<string> {
  const id = tileIdFor(lon, lat);
  const [w, s, e, n] = tileBbox(id);
  await tx
    .insert(tiles)
    .values({ id, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, hasCoast: true })
    .onConflictDoNothing();
  return id;
}

/** A valid polygon object of `type` over the box (a parent candidate of the hierarchy rule). */
async function insertPolygon(tx: Db, type: GeoObjectType, w: number, s: number, e: number, n: number): Promise<string> {
  const [row] = await tx
    .insert(geoObjects)
    .values({ type, origin: "osm", geom: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)` })
    .returning({ id: geoObjects.id });
  return row!.id;
}

/** Greek letters without ELOT 743 digraph rules, with their transliteration, indexed by a hex digit. */
const GREEK_HEX: [string, string][] = [
  ["α", "a"], ["β", "v"], ["δ", "d"], ["ε", "e"], ["ζ", "z"], ["η", "i"], ["θ", "th"], ["κ", "k"],
  ["λ", "l"], ["μ", "m"], ["ν", "n"], ["ξ", "x"], ["ο", "o"], ["ρ", "r"], ["φ", "f"], ["χ", "ch"],
];

const decide = (tx: Db, taskId: string, decision: ReviewDecision, extra: { openedAt?: Date; now?: Date } = {}) =>
  decideReviewTask(tx, { taskId, decision, decidedBy: ADMIN, ...extra });

describe("reviewDecisionSchema", () => {
  it("accepts the documented decisions and rejects unknown actions", () => {
    expect(reviewDecisionSchema.parse({ action: "confirm", kind: "marina" })).toEqual({
      action: "confirm",
      kind: "marina",
    });
    expect(() => reviewDecisionSchema.parse({ action: "confirm", kind: "castle" })).toThrow();
    expect(() => reviewDecisionSchema.parse({ action: "merge", intoPlaceId: "x" })).toThrow();
    expect(() => reviewDecisionSchema.parse({ action: "explode" })).toThrow();
  });
});

describe("place decisions", () => {
  it("confirm sets status, kind, position and an sp_ id; the task is decided with one decision row", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx);
      const taskId = await placeTask(tx, place.id);
      await decide(tx, taskId, { action: "confirm", kind: "marina", position: { lon: 28.3, lat: 35.2 } });
      const row = await placeOf(tx, place.id);
      expect(row).toMatchObject({ status: "confirmed", kind: "marina", lon: 28.3, lat: 35.2 });
      expect(row.tileId).toBe(tileIdFor(28.3, 35.2));
      expect(isPublicId(row.publicId!, "sp")).toBe(true);
      expect((await taskOf(tx, taskId)).status).toBe("decided");
      const decisions = await decisionsOf(tx, taskId);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        decision: { action: "confirm", kind: "marina", position: { lon: 28.3, lat: 35.2 } },
        decidedBy: ADMIN,
        durationMs: null,
      });
    }));

  it("confirm assigns sp_ once and keeps it on a second confirmation via a new task", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx);
      await decide(tx, await placeTask(tx, place.id), { action: "confirm", kind: "anchorage" });
      const first = (await placeOf(tx, place.id)).publicId;
      expect(isPublicId(first!, "sp")).toBe(true);
      await decide(tx, await placeTask(tx, place.id), { action: "confirm", kind: "port" });
      const row = await placeOf(tx, place.id);
      expect(row.publicId).toBe(first);
      expect(row).toMatchObject({ kind: "port", lon: LON, lat: LAT });
    }));

  it("merge rejects the place as merged into the target; the target's open task stays", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx);
      const target = await insertPlace(tx, { lon: 28.11 });
      const taskId = await placeTask(tx, place.id);
      const targetTask = await placeTask(tx, target.id);
      await decide(tx, taskId, { action: "merge", intoPlaceId: target.id });
      expect(await placeOf(tx, place.id)).toMatchObject({
        status: "rejected",
        statusReason: "merged",
        mergedIntoId: target.id,
      });
      expect((await taskOf(tx, targetTask)).status).toBe("open");
      expect((await placeOf(tx, target.id)).status).toBe("candidate");
    }));

  it("merge into itself or into a rejected place is DecisionNotAllowed", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx);
      const rejected = await insertPlace(tx, { lon: 28.12, status: "rejected" });
      const taskId = await placeTask(tx, place.id);
      await expect(
        tx.transaction((sp) => decide(sp, taskId, { action: "merge", intoPlaceId: place.id })),
      ).rejects.toThrow(DecisionNotAllowed);
      await expect(
        tx.transaction((sp) => decide(sp, taskId, { action: "merge", intoPlaceId: rejected.id })),
      ).rejects.toThrow(DecisionNotAllowed);
      await expect(
        tx.transaction((sp) => decide(sp, taskId, { action: "merge", intoPlaceId: newId() })),
      ).rejects.toThrow(DecisionNotAllowed);
      expect((await taskOf(tx, taskId)).status).toBe("open");
      expect(await decisionsOf(tx, taskId)).toHaveLength(0);
      expect((await placeOf(tx, place.id)).status).toBe("candidate");
    }));

  it("reject sets status rejected", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx);
      const taskId = await placeTask(tx, place.id);
      await decide(tx, taskId, { action: "reject" });
      expect(await placeOf(tx, place.id)).toMatchObject({ status: "rejected", publicId: null });
      expect((await taskOf(tx, taskId)).status).toBe("decided");
    }));

  it("no_anchoring sets status no_anchoring with reason review", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx);
      const taskId = await placeTask(tx, place.id);
      await decide(tx, taskId, { action: "no_anchoring" });
      expect(await placeOf(tx, place.id)).toMatchObject({ status: "no_anchoring", statusReason: "review" });
    }));

  it("confirm, merge, reject and no_anchoring return the place's object (merge: the target's) to consolidate after the commit (final review I-2, GR-3)", () =>
    withRollback(async (tx) => {
      const target = await insertPlace(tx, { lon: 28.13 });
      const cases: ReviewDecision[] = [
        { action: "confirm", kind: "anchorage" },
        { action: "merge", intoPlaceId: target.id },
        { action: "reject" },
        { action: "no_anchoring" },
      ];
      for (const decision of cases) {
        const place = await insertPlace(tx);
        const result = await decide(tx, await placeTask(tx, place.id), decision);
        const geoObjectId = decision.action === "merge" ? target.geoObjectId : place.geoObjectId;
        expect(result, decision.action).toEqual({ documentVersionIds: [], consolidate: { geoObjectId } });
        // the decision itself never consolidates (ruling M5-F-R4)
        expect(await tx.select().from(profiles).where(eq(profiles.geoObjectId, place.geoObjectId))).toEqual([]);
      }
    }));

  it("the consolidation after no_anchoring carries the exclusion into the profile as a safety change (final review I-2)", () =>
    withRollback(async (tx) => {
      const { rows } = await tx.execute<{ today: string }>(sql`select current_date::text as today`);
      const today = rows[0]!.today;
      const place = await insertPlace(tx, { status: "confirmed" });
      await consolidateGeo(tx, place.geoObjectId, { today });
      const { consolidate } = await decide(tx, await placeTask(tx, place.id), { action: "no_anchoring" });
      expect(await consolidateGeo(tx, consolidate!.geoObjectId, { today })).toMatchObject({ status: "created", version: 2 });
      const events = await tx
        .select({ newValue: changeEvents.newValue, severity: changeEvents.severity })
        .from(changeEvents)
        .where(and(eq(changeEvents.geoObjectId, place.geoObjectId), eq(changeEvents.attribute, "exclude")));
      expect(events).toEqual([{ newValue: { excluded: true, reason: "anchoringProhibited", detail: null }, severity: "safety" }]);
    }));

  it("an action of another kind is DecisionNotAllowed", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx);
      const taskId = await placeTask(tx, place.id);
      for (const decision of [{ action: "same" }, { action: "retry" }, { action: "no_area" }] as ReviewDecision[]) {
        await expect(tx.transaction((sp) => decide(sp, taskId, decision))).rejects.toThrow(DecisionNotAllowed);
      }
      expect((await taskOf(tx, taskId)).status).toBe("open");
    }));

  it("records duration_ms from openedAt", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx);
      const taskId = await placeTask(tx, place.id);
      const openedAt = new Date("2026-10-19T10:00:00Z");
      const now = new Date("2026-10-19T10:00:42.500Z");
      await decide(tx, taskId, { action: "reject" }, { openedAt, now });
      const [row] = await decisionsOf(tx, taskId);
      expect(row).toMatchObject({ durationMs: 42_500, decidedAt: now });
    }));

  it("a task that is not open throws TaskNotOpen", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx);
      const taskId = await placeTask(tx, place.id);
      await tx.update(reviewTasks).set({ status: "dismissed" }).where(eq(reviewTasks.id, taskId));
      await expect(tx.transaction((sp) => decide(sp, taskId, { action: "reject" }))).rejects.toThrow(TaskNotOpen);
      await expect(tx.transaction((sp) => decide(sp, newId(), { action: "reject" }))).rejects.toThrow(TaskNotOpen);
    }));
});

describe("deciding twice", () => {
  // Needs two committing connections, so it cannot run in withRollback: the synthetic place stays in the
  // test database, outside the pilot box.
  it("deciding twice: the second call throws TaskNotOpen and only one decision row exists", async () => {
    const place = await db.transaction((tx) => insertPlace(tx, { lon: 28.2, lat: 35.15 }));
    const taskId = await placeTask(db, place.id);
    const results = await Promise.allSettled([
      decide(db, taskId, { action: "confirm", kind: "anchorage" }),
      decide(db, taskId, { action: "reject" }),
    ]);
    const fulfilled = results.findIndex((r) => r.status === "fulfilled");
    const rejected = results.find((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(TaskNotOpen);
    expect(await decisionsOf(db, taskId)).toHaveLength(1);
    expect((await placeOf(db, place.id)).status).toBe(fulfilled === 0 ? "confirmed" : "rejected");
  });
});

describe("pair decisions", () => {
  async function pairTask(tx: Db, a: string, b: string): Promise<string> {
    const { id } = await createReviewTask(tx, {
      kind: "place_candidate",
      subjectType: "geo_object_pair",
      subjectId: [a, b].sort().join(":"),
      context: {},
    });
    return id;
  }

  it("same merges into the object with an osm_id", () =>
    withRollback(async (tx) => {
      const older = await insertObject(tx, { name: "Ormos Test" });
      const withOsm = await insertObject(tx, { osmId: `node/${Date.now()}`, name: "Ormos Testi" });
      const taskId = await pairTask(tx, older, withOsm);
      await decide(tx, taskId, { action: "same" });
      const [dropped] = await tx.select().from(geoObjects).where(eq(geoObjects.id, older));
      expect(dropped!.mergedIntoId).toBe(withOsm);
      expect(dropped!.validTo).not.toBeNull();
      expect((await taskOf(tx, taskId)).status).toBe("decided");
    }));

  it("same without osm_id keeps the older object", () =>
    withRollback(async (tx) => {
      const older = await insertObject(tx);
      const newer = await insertObject(tx);
      await decide(tx, await pairTask(tx, older, newer), { action: "same" });
      const [dropped] = await tx.select().from(geoObjects).where(eq(geoObjects.id, newer));
      expect(dropped!.mergedIntoId).toBe(older);
    }));

  it("same with an object already merged is DecisionNotAllowed", () =>
    withRollback(async (tx) => {
      const older = await insertObject(tx);
      const a = await insertObject(tx);
      const b = await insertObject(tx);
      const taskId = await pairTask(tx, a, b);
      await decide(tx, await pairTask(tx, older, b), { action: "same" }); // b merged into older
      await expect(tx.transaction((sp) => decide(sp, taskId, { action: "same" }))).rejects.toThrow(
        DecisionNotAllowed,
      );
      expect((await taskOf(tx, taskId)).status).toBe("open");
    }));

  it("distinct changes no data besides the decision", () =>
    withRollback(async (tx) => {
      const a = await insertObject(tx);
      const b = await insertObject(tx);
      const taskId = await pairTask(tx, a, b);
      await decide(tx, taskId, { action: "distinct" });
      const rows = await tx.select().from(geoObjects).where(sql`${geoObjects.id} in (${a}, ${b})`);
      expect(rows.every((r) => r.mergedIntoId === null && r.validTo === null)).toBe(true);
      expect((await taskOf(tx, taskId)).status).toBe("decided");
      expect(await decisionsOf(tx, taskId)).toHaveLength(1);
    }));
});

describe("coast tile decisions", () => {
  async function tileTask(tx: Db, tileId: string): Promise<string> {
    const { id } = await createReviewTask(tx, {
      kind: "coast_tile_without_area",
      subjectType: "tile",
      subjectId: tileId,
      context: {},
    });
    return id;
  }

  it("assign_area sets the area of the tile", () =>
    withRollback(async (tx) => {
      const tileId = await ensureTile(tx, LON, LAT);
      const area = await insertObject(tx, { type: "area" });
      const taskId = await tileTask(tx, tileId);
      await decide(tx, taskId, { action: "assign_area", areaId: area });
      const [tile] = await tx.select().from(tiles).where(eq(tiles.id, tileId));
      expect(tile!.areaId).toBe(area);
      expect((await taskOf(tx, taskId)).status).toBe("decided");
    }));

  it("assign_area to a non-area geo object is DecisionNotAllowed", () =>
    withRollback(async (tx) => {
      const tileId = await ensureTile(tx, LON, LAT);
      const bay = await insertObject(tx, { type: "bay" });
      const taskId = await tileTask(tx, tileId);
      await expect(
        tx.transaction((sp) => decide(sp, taskId, { action: "assign_area", areaId: bay })),
      ).rejects.toThrow(DecisionNotAllowed);
      const [tile] = await tx.select().from(tiles).where(eq(tiles.id, tileId));
      expect(tile!.areaId).toBeNull();
    }));

  it("no_area changes no data besides the decision", () =>
    withRollback(async (tx) => {
      const tileId = await ensureTile(tx, LON, LAT);
      const taskId = await tileTask(tx, tileId);
      await decide(tx, taskId, { action: "no_area" });
      const [tile] = await tx.select().from(tiles).where(eq(tiles.id, tileId));
      expect(tile!.areaId).toBeNull();
      expect((await taskOf(tx, taskId)).status).toBe("decided");
    }));
});

describe("failed job decisions", () => {
  async function jobTask(tx: Db, jobId: string, queue: unknown = "seed.tile"): Promise<string> {
    const { id } = await createReviewTask(tx, {
      kind: "failed_job",
      subjectType: "job",
      subjectId: jobId,
      context: { queue },
    });
    return id;
  }

  it("retry of a task whose queue is no work queue is DecisionNotAllowed", () =>
    withRollback(async (tx) => {
      const retryJob = vi.fn();
      for (const queue of ["nope", "system.dead", null]) {
        const taskId = await jobTask(tx, newId(), queue);
        await expect(
          tx.transaction((sp) => decideReviewTask(sp, { taskId, decision: { action: "retry" }, decidedBy: ADMIN }, { retryJob })),
        ).rejects.toThrow(DecisionNotAllowed);
        expect((await taskOf(tx, taskId)).status).toBe("open");
        expect(await decisionsOf(tx, taskId)).toHaveLength(0);
      }
      expect(retryJob).not.toHaveBeenCalled();
    }));

  it("retry retries the job through deps.retryJob", () =>
    withRollback(async (tx) => {
      const jobId = newId();
      const taskId = await jobTask(tx, jobId);
      const retryJob = vi.fn().mockResolvedValue(undefined);
      await decideReviewTask(tx, { taskId, decision: { action: "retry" }, decidedBy: ADMIN }, { retryJob });
      expect(retryJob).toHaveBeenCalledWith("seed.tile", jobId);
      expect((await taskOf(tx, taskId)).status).toBe("decided");
    }));

  it("retry without deps.retryJob fails and leaves the task open", () =>
    withRollback(async (tx) => {
      const taskId = await jobTask(tx, newId());
      await expect(tx.transaction((sp) => decide(sp, taskId, { action: "retry" }))).rejects.toThrow();
      expect((await taskOf(tx, taskId)).status).toBe("open");
      expect(await decisionsOf(tx, taskId)).toHaveLength(0);
    }));

  it("ignore only decides the task", () =>
    withRollback(async (tx) => {
      const taskId = await jobTask(tx, newId());
      const retryJob = vi.fn();
      await decideReviewTask(tx, { taskId, decision: { action: "ignore" }, decidedBy: ADMIN }, { retryJob });
      expect(retryJob).not.toHaveBeenCalled();
      expect((await taskOf(tx, taskId)).status).toBe("decided");
      expect(await decisionsOf(tx, taskId)).toHaveLength(1);
    }));
});

describe("source decisions", () => {
  const testDomain = () => `${newId()}.test.invalid`;

  async function insertSource(tx: Db, status: SourceStatus = "proposed", domain = testDomain()): Promise<string> {
    const [row] = await tx
      .insert(sources)
      .values({
        domain,
        name: domain,
        type: "trip_report",
        weight: 0.6,
        status,
        crawlRules: DEFAULT_CRAWL_RULES,
        origin: "serp",
      })
      .returning({ id: sources.id });
    return row!.id;
  }

  async function approvalTask(tx: Db, sourceId: string): Promise<string> {
    const { id } = await createReviewTask(tx, {
      kind: "source_approval",
      subjectType: "source",
      subjectId: sourceId,
      context: {},
    });
    return id;
  }

  async function jobTask(tx: Db, context: Record<string, unknown>): Promise<string> {
    const { id } = await createReviewTask(tx, {
      kind: "failed_job",
      subjectType: "job",
      subjectId: newId(),
      context,
    });
    return id;
  }

  const historyRows = async (tx: Db, sourceId: string) =>
    (await tx.execute<{ n: number }>(sql`select count(*)::int as n from sources_history where row_id = ${sourceId}`))
      .rows[0]!.n;

  const approve = {
    action: "approve",
    type: "pilot_guide",
    weight: 0.85,
    changeRate: "static",
    crawlRules: { ...DEFAULT_CRAWL_RULES, startUrls: ["https://example.test.invalid/guide/"], allow: ["^/guide/"] },
  } as const satisfies ReviewDecision;

  /** The fingerprint the approval form posts: the source's settings as the form shows them (W4-1). */
  const shownKey = async (tx: Db, sourceId: string) => {
    const source = await getSource(tx, sourceId);
    return source ? sourceSettingsKey(source) : "0000000000000000";
  };
  const decideApprove = async (tx: Db, taskId: string, sourceId: string, decision: ReviewDecision = approve) =>
    decideReviewTask(tx, { taskId, decision, decidedBy: ADMIN, valueKey: await shownKey(tx, sourceId) });

  it("accepts approve and pause_source in the schema", () => {
    expect(reviewDecisionSchema.parse({ action: "pause_source" })).toEqual({ action: "pause_source" });
    expect(() => reviewDecisionSchema.parse({ ...approve, weight: 1.5 })).toThrow();
    expect(() => reviewDecisionSchema.parse({ ...approve, type: "castle" })).toThrow();
  });

  it("approve sets type, weight, rules and status in one decision", () =>
    withRollback(async (tx) => {
      const sourceId = await insertSource(tx);
      const taskId = await approvalTask(tx, sourceId);
      await decideApprove(tx, taskId, sourceId);

      expect(await getSource(tx, sourceId)).toMatchObject({
        status: "approved",
        statusReason: null,
        type: "pilot_guide",
        weight: 0.85,
        changeRate: "static",
        crawlRules: approve.crawlRules,
      });
      expect((await taskOf(tx, taskId)).status).toBe("decided");
      const decisions = await decisionsOf(tx, taskId);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.decision).toMatchObject({ action: "approve", type: "pilot_guide" });
      expect(await historyRows(tx, sourceId)).toBeGreaterThanOrEqual(1);
    }));

  it("approve refuses with TaskContextChanged when the source changed since the form was shown (W4-1)", () =>
    withRollback(async (tx) => {
      const sourceId = await insertSource(tx);
      const taskId = await approvalTask(tx, sourceId);
      const shown = await shownKey(tx, sourceId);
      // edited on the source page (another tab) after the approval form was rendered
      await tx
        .update(sources)
        .set({ weight: 0.2, crawlRules: { ...DEFAULT_CRAWL_RULES, deny: ["/forum/"] } })
        .where(eq(sources.id, sourceId));

      await expect(
        tx.transaction((sp) => decideReviewTask(sp, { taskId, decision: approve, decidedBy: ADMIN, valueKey: shown })),
      ).rejects.toThrow(TaskContextChanged);
      // without a fingerprint the approval is refused as well
      await expect(tx.transaction((sp) => decide(sp, taskId, approve))).rejects.toThrow(TaskContextChanged);
      expect((await taskOf(tx, taskId)).status).toBe("open");
      expect(await decisionsOf(tx, taskId)).toHaveLength(0);
      expect(await getSource(tx, sourceId)).toMatchObject({
        status: "proposed",
        weight: 0.2,
        crawlRules: { deny: ["/forum/"] },
      });

      // the reloaded form carries the new fingerprint, so the approval goes through
      await decideApprove(tx, taskId, sourceId);
      expect((await getSource(tx, sourceId))!.status).toBe("approved");
    }));

  it("approving a source that is not proposed is not allowed", () =>
    withRollback(async (tx) => {
      for (const status of ["approved", "rejected", "paused"] as const) {
        const sourceId = await insertSource(tx, status);
        const taskId = await approvalTask(tx, sourceId);
        await expect(tx.transaction((sp) => decide(sp, taskId, approve))).rejects.toThrow(DecisionNotAllowed);
        expect((await taskOf(tx, taskId)).status).toBe("open");
        expect(await decisionsOf(tx, taskId)).toHaveLength(0);
        expect((await getSource(tx, sourceId))!).toMatchObject({ status, type: "trip_report", weight: 0.6 });
      }
      // A task whose source does not exist.
      const taskId = await approvalTask(tx, newId());
      await expect(tx.transaction((sp) => decide(sp, taskId, approve))).rejects.toThrow(DecisionNotAllowed);
    }));

  it("an invalid regex in the rules is rejected before anything is written", () =>
    withRollback(async (tx) => {
      const sourceId = await insertSource(tx);
      const taskId = await approvalTask(tx, sourceId);
      const invalid = { ...approve, crawlRules: { ...approve.crawlRules, deny: ["(unclosed"] } };
      await expect(tx.transaction((sp) => decide(sp, taskId, invalid))).rejects.toThrow(/regular expression/);
      expect((await taskOf(tx, taskId)).status).toBe("open");
      expect(await decisionsOf(tx, taskId)).toHaveLength(0);
      expect((await getSource(tx, sourceId))!.status).toBe("proposed");
    }));

  it("a source on a forbidden domain is never approved (ruling M6-D-R2)", () =>
    withRollback(async (tx) => {
      const sourceId = await insertSource(tx, "proposed", `${newId()}.navily.com`);
      const taskId = await approvalTask(tx, sourceId);
      await expect(tx.transaction((sp) => decide(sp, taskId, approve))).rejects.toThrow(/forbidden domain/);
      expect((await getSource(tx, sourceId))!.status).toBe("proposed");
      expect((await taskOf(tx, taskId)).status).toBe("open");
    }));

  it("reject keeps the domain out of later proposals", () =>
    withRollback(async (tx) => {
      const domain = testDomain();
      for (let i = 0; i < 3; i++) {
        const [q] = await tx
          .insert(serpQueries)
          .values({
            keyword: `kw ${i} ${domain}`,
            languageCode: "en",
            locationCode: 2826,
            depth: 20,
            level: "area",
            scopeId: "saronic",
            rawKey: `serp/2026-10-19/${newId()}.json`,
            fetchedAt: new Date(),
          })
          .returning({ id: serpQueries.id });
        const url = `https://${domain}/blog/p${i}`;
        await tx
          .insert(serpResults)
          .values({ serpQueryId: q!.id, rank: 1, url, urlNormalized: url, domain, title: "t", snippet: "s" });
      }
      const proposals = getConfig().discovery.proposals;
      const sourceId = await insertSource(tx, "proposed", domain);
      const taskId = await approvalTask(tx, sourceId);
      await decide(tx, taskId, { action: "reject" });

      expect((await getSource(tx, sourceId))!).toMatchObject({ status: "rejected", statusReason: "review" });
      expect((await taskOf(tx, taskId)).status).toBe("decided");
      expect(await decisionsOf(tx, taskId)).toHaveLength(1);
      expect((await domainCandidates(tx, proposals)).map((c) => c.domain)).not.toContain(domain);
    }));

  it("place actions do not fit a source approval and approve does not fit a place", () =>
    withRollback(async (tx) => {
      const sourceTask = await approvalTask(tx, await insertSource(tx));
      await expect(tx.transaction((sp) => decide(sp, sourceTask, { action: "no_anchoring" }))).rejects.toThrow(
        DecisionNotAllowed,
      );
      const place = await insertPlace(tx);
      const placeTaskId = await placeTask(tx, place.id);
      await expect(tx.transaction((sp) => decide(sp, placeTaskId, approve))).rejects.toThrow(DecisionNotAllowed);
    }));

  it("pause_source pauses the failed job's source", () =>
    withRollback(async (tx) => {
      const sourceId = await insertSource(tx, "approved");
      const taskId = await jobTask(tx, { queue: "seed.tile", key: "k-1", sourceId });
      const retryJob = vi.fn();
      await decideReviewTask(tx, { taskId, decision: { action: "pause_source" }, decidedBy: ADMIN }, { retryJob });

      expect((await getSource(tx, sourceId))!).toMatchObject({
        status: "paused",
        statusReason: "Job fehlgeschlagen: seed.tile/k-1",
      });
      expect(retryJob).not.toHaveBeenCalled();
      expect((await taskOf(tx, taskId)).status).toBe("decided");
      expect(await decisionsOf(tx, taskId)).toHaveLength(1);
    }));

  it("pause_source without sourceId in the context is not allowed", () =>
    withRollback(async (tx) => {
      for (const context of [{ queue: "seed.tile", key: "k" }, { queue: "seed.tile", key: "k", sourceId: 42 }, {
        queue: "seed.tile",
        key: "k",
        sourceId: newId(),
      }]) {
        const taskId = await jobTask(tx, context);
        await expect(tx.transaction((sp) => decide(sp, taskId, { action: "pause_source" }))).rejects.toThrow(
          DecisionNotAllowed,
        );
        expect((await taskOf(tx, taskId)).status).toBe("open");
        expect(await decisionsOf(tx, taskId)).toHaveLength(0);
      }
    }));

  it("pause_source of a source that is proposed or rejected is not allowed", () =>
    withRollback(async (tx) => {
      for (const status of ["proposed", "rejected"] as const) {
        const sourceId = await insertSource(tx, status);
        const taskId = await jobTask(tx, { queue: "seed.tile", key: "k", sourceId });
        await expect(tx.transaction((sp) => decide(sp, taskId, { action: "pause_source" }))).rejects.toThrow(
          DecisionNotAllowed,
        );
        expect((await getSource(tx, sourceId))!.status).toBe(status);
      }
    }));

  it("pause_source does not fit a source approval task", () =>
    withRollback(async (tx) => {
      const sourceId = await insertSource(tx);
      const taskId = await approvalTask(tx, sourceId);
      await expect(tx.transaction((sp) => decide(sp, taskId, { action: "pause_source" }))).rejects.toThrow(
        DecisionNotAllowed,
      );
    }));
});

describe("name candidate decisions", () => {
  // The candidate's tile at LON/LAT; a new name found in two documents of two sources.
  async function nameTask(tx: Db, o: { hint?: string | null; name?: string } = {}) {
    const tileId = await ensureTile(tx, LON, LAT);
    const name = o.name ?? `Xen${newId().slice(-8).replace(/\d/g, (d) => "ghijklmnop"[Number(d)]!)}`;
    const [candidate] = await tx
      .insert(nameCandidates)
      .values({ nameNormalized: name.toLowerCase(), displayName: name, hint: o.hint === undefined ? "bay" : o.hint, tileId, status: "review", documents: 2, sources: 2 })
      .returning({ id: nameCandidates.id });
    const versionIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const sourceId = await insertTestSource(tx);
      const v = await insertTestVersion(tx, [`Wir ankerten in der Bucht von ${name}.`], { sourceId });
      await tx.insert(unmatchedNames).values({
        nameNormalized: name.toLowerCase(),
        displayName: name,
        hint: "bay",
        documentVersionId: v.versionId,
        chunkId: v.chunkIds[0]!,
        sourceId,
        tileId,
      });
      versionIds.push(v.versionId);
    }
    const { id: taskId } = await createReviewTask(tx, {
      kind: "place_candidate",
      subjectType: "name_candidate",
      subjectId: candidate!.id,
      context: { name, tileId },
    });
    return { taskId, candidateId: candidate!.id, tileId, name, versionIds: versionIds.sort() };
  }

  const createPlace = (name: string, extra: Partial<Extract<ReviewDecision, { action: "create_place" }>> = {}): ReviewDecision => ({
    action: "create_place",
    kind: "anchorage",
    position: { lon: LON + 0.01, lat: LAT + 0.01 },
    name,
    language: "en",
    ...extra,
  });

  const candidateStatus = async (tx: Db, id: string) =>
    (await tx.select({ status: nameCandidates.status }).from(nameCandidates).where(eq(nameCandidates.id, id)))[0]!.status;

  /** The object created by the decision: the one whose valid names include `name` with origin text. */
  async function createdObject(tx: Db, name: string) {
    const [row] = await tx
      .select({
        id: geoObjects.id,
        type: geoObjects.type,
        origin: geoObjects.origin,
        category: geoObjects.category,
        publicId: geoObjects.publicId,
        parentId: geoObjects.parentId,
      })
      .from(geoObjects)
      .innerJoin(geoNames, eq(geoNames.geoObjectId, geoObjects.id))
      .where(and(eq(geoNames.name, name), eq(geoNames.origin, "text")));
    return row;
  }

  it("create_place makes a bay object under its island, its name and a confirmed place in one decision", () =>
    withRollback(async (tx) => {
      // The bay's position LON+0.01/LAT+0.01 lies on an island inside an area: the island is the parent (Spec 03 step 6).
      await insertPolygon(tx, "area", LON - 0.1, LAT - 0.1, LON + 0.1, LAT + 0.1);
      const islandId = await insertPolygon(tx, "island", LON, LAT, LON + 0.02, LAT + 0.02);
      const t = await nameTask(tx);
      const result = await decide(tx, t.taskId, createPlace(t.name));

      expect(result).toEqual({ documentVersionIds: t.versionIds, consolidate: null });
      const object = await createdObject(tx, t.name);
      expect(object).toMatchObject({ type: "bay", origin: "text", category: null, parentId: islandId });
      const names = await tx
        .select({ name: geoNames.name, language: geoNames.language, origin: geoNames.origin, isPreferred: geoNames.isPreferred })
        .from(geoNames)
        .where(eq(geoNames.geoObjectId, object!.id))
        .orderBy(geoNames.language);
      expect(names).toEqual([
        { name: t.name, language: "de", origin: "fallback", isPreferred: true },
        { name: t.name, language: "en", origin: "text", isPreferred: true },
      ]);
      const links = await tx.select().from(tileGeoObjects).where(eq(tileGeoObjects.geoObjectId, object!.id));
      expect(links.map((l) => l.tileId)).toEqual([t.tileId]);
      const [place] = await tx.select({ id: places.id }).from(places).where(eq(places.geoObjectId, object!.id));
      const p = await placeOf(tx, place!.id);
      expect(p).toMatchObject({ kind: "anchorage", status: "confirmed", tileId: t.tileId });
      expect(isPublicId(p.publicId!, "sp")).toBe(true);
      expect(p.lon).toBeCloseTo(LON + 0.01, 6);
      expect(p.lat).toBeCloseTo(LAT + 0.01, 6);
      expect(await candidateStatus(tx, t.candidateId)).toBe("decided");
      expect((await taskOf(tx, t.taskId)).status).toBe("decided");
      expect(await decisionsOf(tx, t.taskId)).toHaveLength(1);
    }));

  it("a poi hint creates a poi object with category and no place", () =>
    withRollback(async (tx) => {
      const t = await nameTask(tx, { hint: "poi:food" });
      await decide(tx, t.taskId, createPlace(t.name, { language: "de" }));

      const object = await createdObject(tx, t.name);
      expect(object).toMatchObject({ type: "poi", category: "food", origin: "text" });
      expect(isPublicId(object!.publicId!, "hl")).toBe(true);
      expect(await tx.select().from(places).where(eq(places.geoObjectId, object!.id))).toEqual([]);
      // A German name needs no fallback.
      const fallbacks = await tx.select().from(geoNames).where(and(eq(geoNames.geoObjectId, object!.id), eq(geoNames.origin, "fallback")));
      expect(fallbacks).toEqual([]);
    }));

  it("an island hint creates an islet without a place under its area; a Greek name gets its transliteration as German fallback", () =>
    withRollback(async (tx) => {
      // An own Greek name: hex digits of a fresh id as Greek letters without digraph rules, with their ELOT 743 form.
      const suffix = [...newId().slice(-6)].map((h) => GREEK_HEX[parseInt(h, 16)]!);
      const name = `Κολώνα ${suffix.map(([g]) => g).join("")}`;
      const latin = `Kolona ${suffix.map(([, l]) => l).join("")}`;
      const areaId = await insertPolygon(tx, "area", LON - 0.1, LAT - 0.1, LON + 0.1, LAT + 0.1);
      const t = await nameTask(tx, { hint: "island", name });
      await decide(tx, t.taskId, createPlace(name, { language: "el" }));

      const object = await createdObject(tx, name);
      expect(object).toMatchObject({ type: "islet", parentId: areaId });
      expect(await tx.select().from(places).where(eq(places.geoObjectId, object!.id))).toEqual([]);
      const names = await tx
        .select({ name: geoNames.name, language: geoNames.language, origin: geoNames.origin })
        .from(geoNames)
        .where(eq(geoNames.geoObjectId, object!.id))
        .orderBy(geoNames.origin);
      expect(names).toEqual(
        expect.arrayContaining([
          { name, language: "el", origin: "text" },
          { name: latin, language: "el", origin: "transliteration" },
          { name: latin, language: "de", origin: "fallback" },
        ]),
      );
    }));

  it("without a known hint the place kind decides the type", () =>
    withRollback(async (tx) => {
      const t = await nameTask(tx, { hint: null });
      await decide(tx, t.taskId, createPlace(t.name, { kind: "marina" }));
      expect(await createdObject(tx, t.name)).toMatchObject({ type: "harbour" });
    }));

  it("assign_name adds a review name to the chosen object", () =>
    withRollback(async (tx) => {
      const t = await nameTask(tx);
      // In a neighbour tile of the candidate's tile.
      const neighbour = await ensureTile(tx, LON + 0.25, LAT);
      const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name: "Other Bay" }], lon: LON + 0.26, lat: LAT, tiles: [neighbour] });
      const result = await decide(tx, t.taskId, { action: "assign_name", geoObjectId: objectId });

      expect(result).toEqual({ documentVersionIds: t.versionIds, consolidate: null });
      const names = await tx
        .select({ name: geoNames.name, language: geoNames.language, origin: geoNames.origin })
        .from(geoNames)
        .where(and(eq(geoNames.geoObjectId, objectId), eq(geoNames.origin, "review")));
      expect(names).toEqual([{ name: t.name, language: "und", origin: "review" }]);
      expect(await candidateStatus(tx, t.candidateId)).toBe("decided");
    }));

  it("assign_name to an object outside the candidate tiles is not allowed", () =>
    withRollback(async (tx) => {
      const t = await nameTask(tx);
      const far = await ensureTile(tx, LON + 0.5, LAT);
      const outside = await insertNamedObject(tx, { type: "bay", names: [{ name: "Far Bay" }], lon: LON + 0.51, lat: LAT, tiles: [far] });
      const ended = await insertNamedObject(tx, { type: "bay", names: [{ name: "Old Bay" }], lon: LON + 0.01, lat: LAT, tiles: [t.tileId] });
      await tx.update(geoObjects).set({ validTo: sql`current_date` }).where(eq(geoObjects.id, ended));

      for (const geoObjectId of [outside, ended, newId()]) {
        await expect(decide(tx, t.taskId, { action: "assign_name", geoObjectId })).rejects.toBeInstanceOf(DecisionNotAllowed);
      }
      expect((await taskOf(tx, t.taskId)).status).toBe("open");
      expect(await decisionsOf(tx, t.taskId)).toHaveLength(0);
      expect(await candidateStatus(tx, t.candidateId)).toBe("review");
    }));

  it("reject only decides the candidate", () =>
    withRollback(async (tx) => {
      const t = await nameTask(tx);
      expect(await decide(tx, t.taskId, { action: "reject" })).toEqual({ documentVersionIds: [], consolidate: null });
      expect(await candidateStatus(tx, t.candidateId)).toBe("decided");
      expect(await createdObject(tx, t.name)).toBeUndefined();
    }));

  it("returns only the current version of each document, superseded versions with the name left out", () =>
    withRollback(async (tx) => {
      const t = await nameTask(tx);
      // A newer version of the first document (it no longer needs to carry the name) replaces the one with the name.
      const [old] = await tx.select({ documentId: documentVersions.documentId }).from(documentVersions).where(eq(documentVersions.id, t.versionIds[0]!));
      const newer = await insertTestVersion(tx, ["Neue Fassung."], { documentId: old!.documentId });
      const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name: "Own Bay" }], lon: LON + 0.01, lat: LAT, tiles: [t.tileId] });
      const result = await decide(tx, t.taskId, { action: "assign_name", geoObjectId: objectId });

      expect(result).toEqual({ documentVersionIds: [newer.versionId, t.versionIds[1]!].sort(), consolidate: null });
    }));

  it("assign_name offers the candidate space of the configured neighbourRing", () =>
    withRollback(async (tx) => {
      const t = await nameTask(tx);
      // Two tiles away: outside ring 1, inside the test switch ring 2.
      const twoAway = await ensureTile(tx, LON + 0.5, LAT);
      const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name: "Ring Bay" }], lon: LON + 0.51, lat: LAT, tiles: [twoAway] });
      RING.value = 2;
      try {
        await decide(tx, t.taskId, { action: "assign_name", geoObjectId: objectId });
      } finally {
        RING.value = undefined;
      }
      expect(await candidateStatus(tx, t.candidateId)).toBe("decided");
    }));

  it("deciding twice fails with TaskNotOpen", () =>
    withRollback(async (tx) => {
      const t = await nameTask(tx);
      await decide(tx, t.taskId, { action: "reject" });
      await expect(decide(tx, t.taskId, createPlace(t.name))).rejects.toBeInstanceOf(TaskNotOpen);
      expect(await decisionsOf(tx, t.taskId)).toHaveLength(1);
      expect(await createdObject(tx, t.name)).toBeUndefined();
    }));

  it("a decided candidate cannot be decided through a second task; place actions do not fit it", () =>
    withRollback(async (tx) => {
      const t = await nameTask(tx);
      await expect(decide(tx, t.taskId, { action: "confirm", kind: "anchorage" })).rejects.toBeInstanceOf(DecisionNotAllowed);
      await tx.update(nameCandidates).set({ status: "decided" }).where(eq(nameCandidates.id, t.candidateId));
      await expect(decide(tx, t.taskId, createPlace(t.name))).rejects.toBeInstanceOf(DecisionNotAllowed);
      expect((await taskOf(tx, t.taskId)).status).toBe("open");
    }));

  it("other decisions return no document versions", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx);
      expect(await decide(tx, await placeTask(tx, place.id), { action: "reject" })).toEqual({ documentVersionIds: [], consolidate: { geoObjectId: place.geoObjectId } });
    }));

  it("the schema bounds name, language and position", () => {
    const base = { action: "create_place", kind: "anchorage", position: { lon: 21, lat: 35 }, name: "Kolona", language: "el" };
    expect(reviewDecisionSchema.parse(base)).toEqual(base);
    expect(() => reviewDecisionSchema.parse({ ...base, name: " " })).toThrow();
    expect(() => reviewDecisionSchema.parse({ ...base, name: "x".repeat(121) })).toThrow();
    expect(() => reviewDecisionSchema.parse({ ...base, language: "ell" })).toThrow();
    expect(() => reviewDecisionSchema.parse({ ...base, position: { lon: 200, lat: 35 } })).toThrow();
    expect(() => reviewDecisionSchema.parse({ action: "assign_name", geoObjectId: "x" })).toThrow();
  });
});

describe("nextOpenTask", () => {
  it("returns the open task with the highest priority, oldest first, after afterId", () =>
    withRollback(async (tx) => {
      // Open tasks of other test files (committed at any time, priorities 0 … 1.5e9) never rank among the test's own:
      // those lie above 1.9e9, `last` below every other task. No shadowing update: it cannot hide rows committed
      // after it.
      const mk = async (priority: number, kind: "failed_job" | "coast_tile_without_area" = "failed_job") =>
        (await createReviewTask(tx, { kind, subjectType: "job", subjectId: newId(), context: {}, priority })).id;
      const low = await mk(1_999_999_999);
      const highOld = await mk(2_000_000_000);
      const highNew = await mk(2_000_000_000);
      const tile = await mk(2_000_000_001, "coast_tile_without_area");
      const decided = await mk(2_000_000_002);
      const last = await mk(-2_000_000_000);
      await tx.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.id, decided));

      expect(await nextOpenTask(tx)).toEqual({ id: tile });
      expect(await nextOpenTask(tx, "failed_job")).toEqual({ id: highOld });
      expect(await nextOpenTask(tx, "failed_job", highOld)).toEqual({ id: highNew });
      expect(await nextOpenTask(tx, "failed_job", highNew)).toEqual({ id: low });
      expect(await nextOpenTask(tx, "failed_job", last)).toBeNull();
      expect(await nextOpenTask(tx, "failed_job", decided)).toEqual({ id: highOld });
    }));
});

describe("profile attribute decisions (conflict, uncertain_change)", () => {
  /** The database's date: the run date of the consolidations and the decision date. */
  let today = "";
  beforeAll(async () => {
    const { rows } = await db.execute<{ today: string }>(sql`select current_date::text as today`);
    today = rows[0]!.today;
  });
  const noon = () => new Date(`${today}T12:00:00Z`);

  /** A confirmed anchorage (computed shelter and depth) whose holding conflicts: good (0.6) against poor (0.5). */
  async function holdingConflict(tx: Db): Promise<{ objectId: string; taskId: string; key: string }> {
    const { objectId } = await insertProfilePlace(tx);
    await insertComputation(tx, objectId, "shelter", { "shelter.N": 0.6 });
    await insertComputation(tx, objectId, "depth", { "depth.min": 4 }, { confidence: 0.85 });
    await insertTextFact(tx, objectId, await insertProfileSource(tx, "trip_report", 0.6), { attribute: "holding", value: "good", observedAt: "2026-07-01" });
    await insertTextFact(tx, objectId, await insertProfileSource(tx, "trip_report", 0.5), { attribute: "holding", value: "poor", observedAt: "2026-07-02" });
    expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "created", tasks: 1 });
    const [task] = await profileTasks(tx, objectId, "holding");
    return { objectId, taskId: task!.id, key: (task!.context as { key: string }).key };
  }

  /** A pilot guide says there is water, a newer single forum says there is none: one open uncertain_change task. */
  async function uncertainWater(tx: Db): Promise<{ objectId: string; taskId: string; key: string; forum: string }> {
    const { objectId } = await insertProfilePlace(tx);
    await insertComputation(tx, objectId, "shelter", { "shelter.N": 0.6 });
    await insertTextFact(tx, objectId, await insertProfileSource(tx, "pilot_guide", 0.9), { attribute: "services.water", value: true, observedAt: "2026-06-01", confidence: 0.9 });
    await consolidateGeo(tx, objectId, { today });
    const forum = await insertProfileSource(tx, "forum", 0.4);
    await insertTextFact(tx, objectId, forum, { attribute: "services.water", value: false, observedAt: "2026-07-01" });
    expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "unchanged", tasks: 1 });
    const [task] = await profileTasks(tx, objectId, "services.water");
    return { objectId, taskId: task!.id, key: (task!.context as { key: string }).key, forum };
  }

  const profileTasks = (tx: Db, objectId: string, attribute: string) =>
    tx
      .select({ id: reviewTasks.id, kind: reviewTasks.kind, status: reviewTasks.status, context: reviewTasks.context })
      .from(reviewTasks)
      .where(and(eq(reviewTasks.subjectType, "profile_attribute"), eq(reviewTasks.subjectId, `${objectId}:${attribute}`)));

  const latest = async (tx: Db, objectId: string) => {
    const rows = await tx.select().from(profiles).where(eq(profiles.geoObjectId, objectId)).orderBy(sql`${profiles.version} desc`).limit(1);
    return rows[0]!;
  };

  const decideProfile = (tx: Db, taskId: string, key: string, action: ReviewDecision, valueKey?: string) =>
    decideReviewTask(tx, { taskId, decision: action, decidedBy: ADMIN, now: noon(), taskKey: key, valueKey });

  it("value_b writes one review fact with confidence 0.95 and the next consolidation shows it without conflict", () =>
    withRollback(async (tx) => {
      const { objectId, taskId, key } = await holdingConflict(tx);
      expect((await latest(tx, objectId)).attributes["holding"]).toBe("good");

      expect(await decideProfile(tx, taskId, key, { action: "value_b" }, valueFingerprint("poor"))).toEqual({ documentVersionIds: [], consolidate: { geoObjectId: objectId } });
      const [decision] = await tx.select({ id: reviewDecisions.id }).from(reviewDecisions).where(eq(reviewDecisions.taskId, taskId));
      const reviewFacts = await tx.select().from(facts).where(eq(facts.reviewDecisionId, decision!.id));
      expect(reviewFacts).toHaveLength(1);
      expect(reviewFacts[0]).toMatchObject({ geoObjectId: objectId, attribute: "holding", value: "poor", confidence: 0.95, observedAt: today, factSchemaVersion: "v2" });

      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "created", tasks: 0 });
      const profile = await latest(tx, objectId);
      expect(profile.attributes["holding"]).toBe("poor");
      expect(profile.conflicts.filter((c) => c.attribute === "holding")).toEqual([]);
      expect(profile.provenance["holding"]).toMatchObject({ origin: "review", factIds: [reviewFacts[0]!.id] });
      expect(await profileTasks(tx, objectId, "holding")).toEqual([expect.objectContaining({ id: taskId, status: "decided" })]);
    }));

  it("value_a / value_b name the value shown: sides swapped by a run under the same key are refused (ruling M5-G-R2)", () =>
    withRollback(async (tx) => {
      const { objectId, taskId, key } = await holdingConflict(tx);
      const sides = async () => {
        const [task] = await profileTasks(tx, objectId, "holding");
        const c = task!.context as { key: string; a: { value: unknown }; b: { value: unknown } };
        return { key: c.key, a: c.a.value, b: c.b.value };
      };
      expect(await sides()).toEqual({ key, a: "good", b: "poor" });
      const shownA = valueFingerprint("good");

      // a third source for "poor" makes it the heavier side: the run swaps a and b, the key stays
      await insertTextFact(tx, objectId, await insertProfileSource(tx, "forum", 0.2), { attribute: "holding", value: "poor", observedAt: "2026-07-03" });
      await consolidateGeo(tx, objectId, { today });
      expect(await sides()).toEqual({ key, a: "poor", b: "good" });

      // "Wert A" was clicked for "good"; the decision would now write "poor"
      await expect(decideProfile(tx, taskId, key, { action: "value_a" }, shownA)).rejects.toThrow(TaskContextChanged);
      await expect(decideProfile(tx, taskId, key, { action: "value_a" })).rejects.toThrow(TaskContextChanged);
      expect(await tx.select().from(reviewDecisions).where(eq(reviewDecisions.taskId, taskId))).toEqual([]);
      expect(await tx.select().from(facts).where(and(eq(facts.geoObjectId, objectId), sql`${facts.reviewDecisionId} is not null`))).toEqual([]);

      // the value as shown now goes through, on either side
      await decideProfile(tx, taskId, key, { action: "value_b" }, shownA);
      const [fact] = await tx.select().from(facts).where(and(eq(facts.geoObjectId, objectId), sql`${facts.reviewDecisionId} is not null`));
      expect(fact).toMatchObject({ attribute: "holding", value: "good" });
    }));

  it("seasonal resolves the conflict marker; no new conflict task for the same key", () =>
    withRollback(async (tx) => {
      const { objectId, taskId, key } = await holdingConflict(tx);
      expect(await decideProfile(tx, taskId, key, { action: "seasonal" })).toEqual({ documentVersionIds: [], consolidate: { geoObjectId: objectId } });
      expect(await tx.select().from(facts).where(and(eq(facts.geoObjectId, objectId), sql`${facts.reviewDecisionId} is not null`))).toEqual([]);

      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "created", tasks: 0, events: 0 });
      const profile = await latest(tx, objectId);
      expect(profile.conflicts.map((c) => [c.attribute, c.key, c.resolution])).toEqual([["holding", key, "seasonal"]]);
      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "unchanged", tasks: 0 });
      expect(await profileTasks(tx, objectId, "holding")).toHaveLength(1);
    }));

  it("leave_open keeps the marker and opens no new task", () =>
    withRollback(async (tx) => {
      const { objectId, taskId, key } = await holdingConflict(tx);
      await decideProfile(tx, taskId, key, { action: "leave_open" });

      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ tasks: 0, events: 0 });
      const profile = await latest(tx, objectId);
      expect(profile.attributes["holding"]).toBe("good");
      expect(profile.conflicts.map((c) => [c.key, c.resolution])).toEqual([[key, "left_open"]]);
      expect(await profileTasks(tx, objectId, "holding")).toHaveLength(1);
    }));

  it("accept_change writes the proposed value; the next run emits changed", () =>
    withRollback(async (tx) => {
      const { objectId, taskId, key } = await uncertainWater(tx);
      expect(await decideProfile(tx, taskId, key, { action: "accept_change" })).toEqual({ documentVersionIds: [], consolidate: { geoObjectId: objectId } });
      const [fact] = await tx.select().from(facts).where(and(eq(facts.geoObjectId, objectId), sql`${facts.reviewDecisionId} is not null`));
      expect(fact).toMatchObject({ attribute: "services.water", value: false, confidence: 0.95, observedAt: today });

      expect(await consolidateGeo(tx, objectId, { today })).toMatchObject({ status: "created", version: 2, tasks: 0 });
      expect((await latest(tx, objectId)).attributes["services.water"]).toBe(false);
      const events = await tx.select().from(changeEvents).where(and(eq(changeEvents.geoObjectId, objectId), eq(changeEvents.attribute, "services.water")));
      expect(events.map((e) => [e.type, e.oldValue, e.newValue, e.profileVersion])).toEqual([
        ["uncertain", true, false, 1],
        ["changed", true, false, 2],
      ]);
    }));

  it("discard keeps the old value on the next run", () =>
    withRollback(async (tx) => {
      const { objectId, taskId, key } = await uncertainWater(tx);
      await decideProfile(tx, taskId, key, { action: "discard_change" });
      expect(await tx.select().from(facts).where(and(eq(facts.geoObjectId, objectId), sql`${facts.reviewDecisionId} is not null`))).toEqual([]);

      expect(await consolidateGeo(tx, objectId, { today })).toEqual({ status: "unchanged", version: 1, events: 0, tasks: 0 });
      expect((await latest(tx, objectId)).attributes["services.water"]).toBe(true);
      expect(await profileTasks(tx, objectId, "services.water")).toEqual([expect.objectContaining({ id: taskId, status: "decided" })]);
    }));

  it("a conflict action on an uncertain_change task is not allowed", () =>
    withRollback(async (tx) => {
      const { taskId, key } = await uncertainWater(tx);
      await expect(decideProfile(tx, taskId, key, { action: "value_a" })).rejects.toThrow(DecisionNotAllowed);
      const holding = await holdingConflict(tx);
      await expect(decideProfile(tx, holding.taskId, holding.key, { action: "accept_change" })).rejects.toThrow(DecisionNotAllowed);
      await expect(decideProfile(tx, holding.taskId, holding.key, { action: "confirm", kind: "marina" })).rejects.toThrow(DecisionNotAllowed);
      expect(await tx.select().from(reviewDecisions).where(inArray(reviewDecisions.taskId, [taskId, holding.taskId]))).toEqual([]);
    }));

  it("a decision on a task whose key changed since it was shown is refused (ruling M5-F-R2)", () =>
    withRollback(async (tx) => {
      const { objectId, taskId, key, forum } = await uncertainWater(tx);
      // a newer document of the same forum: the next run replaces the open task's context with another key
      await insertTextFact(tx, objectId, forum, { attribute: "services.water", value: false, observedAt: "2026-08-01" });
      await consolidateGeo(tx, objectId, { today });
      const [task] = await profileTasks(tx, objectId, "services.water");
      const newKey = (task!.context as { key: string }).key;
      expect(task).toMatchObject({ id: taskId, status: "open" });
      expect(newKey).not.toBe(key);

      await expect(decideProfile(tx, taskId, key, { action: "accept_change" })).rejects.toThrow(TaskContextChanged);
      await expect(decideReviewTask(tx, { taskId, decision: { action: "accept_change" }, decidedBy: ADMIN })).rejects.toThrow(TaskContextChanged);
      expect(await tx.select().from(reviewDecisions).where(eq(reviewDecisions.taskId, taskId))).toEqual([]);
      expect(await decideProfile(tx, taskId, newKey, { action: "accept_change" })).toMatchObject({ consolidate: { geoObjectId: objectId } });
    }));

  it("regenerate_summary on a summary task of a missing geo object is not allowed (M5-G-M5)", () =>
    withRollback(async (tx) => {
      const missing = newId();
      const [task] = await tx
        .insert(reviewTasks)
        .values({ kind: "failed_job", subjectType: "profile_summary", subjectId: `${missing}:1`, context: {} })
        .returning({ id: reviewTasks.id });
      await expect(decideReviewTask(tx, { taskId: task!.id, decision: { action: "regenerate_summary" }, decidedBy: ADMIN })).rejects.toThrow(DecisionNotAllowed);
      expect(await tx.select().from(reviewDecisions).where(eq(reviewDecisions.taskId, task!.id))).toEqual([]);
    }));

  it("a decision never takes the profile lock (ruling M5-F-R4)", async () => {
    // a consolidation holding `profile:<id>` does not block the decision (lock_timeout 300 ms would fail it)
    const objectId = newId();
    const result = await startWhileLocked(db, `profile:${objectId}`, async (tx) => {
      const [object] = await tx.insert(geoObjects).values({ id: objectId, type: "bay", origin: "geonames", geom: sql`${geomFromGeoJson(point(LON, LAT))}` }).returning({ id: geoObjects.id });
      const [task] = await tx
        .insert(reviewTasks)
        .values({ kind: "uncertain_change", subjectType: "profile_attribute", subjectId: `${object!.id}:services.water`, context: { key: "k1", attribute: "services.water", oldValue: true, newValue: false } })
        .returning({ id: reviewTasks.id });
      return decideReviewTask(tx, { taskId: task!.id, decision: { action: "accept_change" }, decidedBy: ADMIN, taskKey: "k1" });
    });
    expect(result).toEqual({ documentVersionIds: [], consolidate: { geoObjectId: objectId } });
  });

  it("a union list with single-entry facts stores the accepted list, every entry validated", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertProfilePlace(tx);
      const notes = [{ kind: "crowded", months: [7, 8] }, { kind: "closed", months: [1] }];
      const [task] = await tx
        .insert(reviewTasks)
        .values({ kind: "uncertain_change", subjectType: "profile_attribute", subjectId: `${objectId}:season_notes`, context: { key: "k", newValue: notes } })
        .returning({ id: reviewTasks.id });
      await decideProfile(tx, task!.id, "k", { action: "accept_change" });
      const [fact] = await tx.select().from(facts).where(and(eq(facts.geoObjectId, objectId), eq(facts.attribute, "season_notes")));
      expect(fact!.value).toEqual(notes);

      const [bad] = await tx
        .insert(reviewTasks)
        .values({ kind: "uncertain_change", subjectType: "profile_attribute", subjectId: `${objectId}:services.fuel`, context: { key: "k", newValue: "yes" } })
        .returning({ id: reviewTasks.id });
      await expect(decideProfile(tx, bad!.id, "k", { action: "accept_change" })).rejects.toThrow(DecisionNotAllowed);
    }));

  it("a failed summary is ignored, or generated again by a summary-only run (ruling M5-P10)", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertProfilePlace(tx);
      const task = async () => {
        const [t] = await tx
          .insert(reviewTasks)
          .values({ kind: "failed_job", subjectType: "profile_summary", subjectId: `${objectId}:1`, context: { geoObjectId: objectId, version: 1 } })
          .returning({ id: reviewTasks.id });
        return t!.id;
      };
      await expect(decide(tx, await task(), { action: "retry" })).rejects.toThrow(DecisionNotAllowed);
      await tx.update(reviewTasks).set({ status: "dismissed" }).where(eq(reviewTasks.subjectId, `${objectId}:1`));
      expect(await decide(tx, await task(), { action: "ignore" })).toEqual({ documentVersionIds: [], consolidate: null });
      expect(await decide(tx, await task(), { action: "regenerate_summary" })).toEqual({
        documentVersionIds: [],
        consolidate: { geoObjectId: objectId, stagesOnly: ["consolidation.summary"] },
      });
    }));
});
