import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
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
import { domainCandidates } from "@/lib/domain/discovery/proposals";
import { isPublicId, newId } from "@/lib/domain/ids";
import { createReviewTask } from "@/lib/domain/review";
import {
  DecisionNotAllowed,
  decideReviewTask,
  nextOpenTask,
  reviewDecisionSchema,
  TaskNotOpen,
  type ReviewDecision,
} from "@/lib/domain/review-decisions";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import { getSource } from "@/lib/domain/sources/store";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { getConfig } from "@/lib/config";
import { testDb, withRollback } from "@/test/db";
import { insertNamedObject, insertTestSource, insertTestVersion } from "@/test/text";

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

  it("accepts approve and pause_source in the schema", () => {
    expect(reviewDecisionSchema.parse({ action: "pause_source" })).toEqual({ action: "pause_source" });
    expect(() => reviewDecisionSchema.parse({ ...approve, weight: 1.5 })).toThrow();
    expect(() => reviewDecisionSchema.parse({ ...approve, type: "castle" })).toThrow();
  });

  it("approve sets type, weight, rules and status in one decision", () =>
    withRollback(async (tx) => {
      const sourceId = await insertSource(tx);
      const taskId = await approvalTask(tx, sourceId);
      await decide(tx, taskId, approve);

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
      .select({ id: geoObjects.id, type: geoObjects.type, origin: geoObjects.origin, category: geoObjects.category, publicId: geoObjects.publicId })
      .from(geoObjects)
      .innerJoin(geoNames, eq(geoNames.geoObjectId, geoObjects.id))
      .where(and(eq(geoNames.name, name), eq(geoNames.origin, "text")));
    return row;
  }

  it("create_place makes a bay object, its name and a confirmed place in one decision", () =>
    withRollback(async (tx) => {
      const t = await nameTask(tx);
      const result = await decide(tx, t.taskId, createPlace(t.name));

      expect(result).toEqual({ documentVersionIds: t.versionIds });
      const object = await createdObject(tx, t.name);
      expect(object).toMatchObject({ type: "bay", origin: "text", category: null });
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

  it("an island hint creates an islet without a place; a Greek name gets its transliteration as German fallback", () =>
    withRollback(async (tx) => {
      const t = await nameTask(tx, { hint: "island", name: "Κολώνα" });
      await decide(tx, t.taskId, createPlace("Κολώνα", { language: "el" }));

      const object = await createdObject(tx, "Κολώνα");
      expect(object).toMatchObject({ type: "islet" });
      expect(await tx.select().from(places).where(eq(places.geoObjectId, object!.id))).toEqual([]);
      const names = await tx
        .select({ name: geoNames.name, language: geoNames.language, origin: geoNames.origin })
        .from(geoNames)
        .where(eq(geoNames.geoObjectId, object!.id))
        .orderBy(geoNames.origin);
      expect(names).toEqual(
        expect.arrayContaining([
          { name: "Κολώνα", language: "el", origin: "text" },
          { name: "Kolona", language: "el", origin: "transliteration" },
          { name: "Kolona", language: "de", origin: "fallback" },
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

      expect(result).toEqual({ documentVersionIds: t.versionIds });
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
      expect(await decide(tx, t.taskId, { action: "reject" })).toEqual({ documentVersionIds: t.versionIds });
      expect(await candidateStatus(tx, t.candidateId)).toBe("decided");
      expect(await createdObject(tx, t.name)).toBeUndefined();
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
      expect(await decide(tx, await placeTask(tx, place.id), { action: "reject" })).toEqual({ documentVersionIds: [] });
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
      // Shadow every other open task so the test sees only its own.
      await tx.update(reviewTasks).set({ status: "dismissed" }).where(eq(reviewTasks.status, "open"));
      const mk = async (priority: number, kind: "failed_job" | "coast_tile_without_area" = "failed_job") =>
        (await createReviewTask(tx, { kind, subjectType: "job", subjectId: newId(), context: {}, priority })).id;
      const low = await mk(0);
      const highOld = await mk(5);
      const highNew = await mk(5);
      const tile = await mk(9, "coast_tile_without_area");
      const decided = await mk(10);
      await tx.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.id, decided));

      expect(await nextOpenTask(tx)).toEqual({ id: tile });
      expect(await nextOpenTask(tx, "failed_job")).toEqual({ id: highOld });
      expect(await nextOpenTask(tx, "failed_job", highOld)).toEqual({ id: highNew });
      expect(await nextOpenTask(tx, "failed_job", highNew)).toEqual({ id: low });
      expect(await nextOpenTask(tx, "failed_job", low)).toBeNull();
      expect(await nextOpenTask(tx, "failed_job", decided)).toEqual({ id: highOld });
    }));
});
