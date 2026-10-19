import type { Polygon } from "geojson";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places, restrictedAreas, reviewTasks, type PlaceStatus, type RestrictedKind } from "@/lib/db/schema";
import { createReviewTask } from "@/lib/domain/review";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import type { Bbox } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";
import { lonLatOf, rect, SYNTHETIC_SRID } from "@/test/geometry/synthetic";
import {
  applyExclusion,
  exclusionFor,
  isAnchoringBan,
  restrictionHits,
  upsertRestrictedAreas,
  type RestrictedFeature,
  type RestrictionHit,
} from "../restrictions";

/** Box around the synthetic reference point (≈ 21.0 E / 35.23 N), outside the pilot box. */
const BOX: Bbox = [20.9, 35.1, 21.1, 35.3];
const TODAY = "2026-10-19";

const cfg = (protectedAreaAnchoringBan: string[] = []) => ({
  noAnchoringKinds: ["military", "aquaculture"] as RestrictedKind[],
  protectedAreaAnchoringBan,
});

/** WGS84 GeoJSON polygon of the EPSG:32634 rectangle x0…x1 × y0…y1 metres from the reference point. */
async function utmRect(tx: Db, x0: number, y0: number, x1: number, y1: number): Promise<Polygon> {
  const { rows } = await tx.execute<{ g: Polygon }>(
    sql`select ST_AsGeoJSON(ST_Transform(ST_GeomFromText(${rect(x0, y0, x1, y1)}, ${SYNTHETIC_SRID}::int), 4326), 15)::json as g`,
  );
  return rows[0]!.g;
}

async function insertRestricted(tx: Db, kind: RestrictedKind, geometry: Polygon, sourceRef: string | null = null) {
  const [row] = await tx
    .insert(restrictedAreas)
    .values({ kind, sourceRef, geom: sql`${geomFromGeoJson(geometry)}` })
    .returning({ id: restrictedAreas.id });
  return row!.id;
}

async function rowsWithPrefix(tx: Db, prefix: string) {
  const { rows } = await tx.execute<{ id: string; source_ref: string; valid_to: string | null }>(sql`
    select id, source_ref, valid_to::text as valid_to from restricted_areas
    where left(source_ref, length(${prefix})) = ${prefix} order by source_ref, valid_from, id`);
  return rows;
}

async function historyCount(tx: Db, ids: string[]): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from restricted_areas_history
    where row_id in (select unnest(${`{${ids.join(",")}}`}::uuid[]))`);
  return rows[0]!.n;
}

describe("upsertRestrictedAreas", () => {
  it("re-import: unchanged rows write no history, a changed geometry updates the same row, a missing one ends", () =>
    withRollback(async (tx) => {
      const prefix = `test:mil-${crypto.randomUUID()}/`;
      const a: RestrictedFeature = { kind: "military", sourceRef: `${prefix}a`, geometry: await utmRect(tx, 0, 0, 500, 500) };
      const b: RestrictedFeature = { kind: "military", sourceRef: `${prefix}b`, geometry: await utmRect(tx, 1000, 0, 1500, 500) };
      const c: RestrictedFeature = { kind: "military", sourceRef: `${prefix}c`, geometry: await utmRect(tx, 2000, 0, 2500, 500) };
      // Outside the box (≈ 21.5 E): never ended by an import of this box.
      const outsideGeom: Polygon = {
        type: "Polygon",
        coordinates: [[[21.5, 35.2], [21.51, 35.2], [21.51, 35.21], [21.5, 35.21], [21.5, 35.2]]],
      };
      const outside: RestrictedFeature = { kind: "military", sourceRef: `${prefix}outside`, geometry: outsideGeom };

      const input = (features: RestrictedFeature[]) => ({ layerPrefix: prefix, box: BOX, features, today: TODAY });

      expect(await upsertRestrictedAreas(tx, input([a, b, c, outside]))).toEqual({
        inserted: 4,
        updated: 0,
        unchanged: 0,
        ended: 0,
      });
      const first = await rowsWithPrefix(tx, prefix);
      const ids = first.map((r) => r.id);

      expect(await upsertRestrictedAreas(tx, input([a, b, c]))).toEqual({ inserted: 0, updated: 0, unchanged: 3, ended: 0 });
      expect(await historyCount(tx, ids)).toBe(0);

      const bChanged = { ...b, geometry: await utmRect(tx, 1000, 0, 1600, 500) };
      expect(await upsertRestrictedAreas(tx, input([a, bChanged, c]))).toEqual({
        inserted: 0,
        updated: 1,
        unchanged: 2,
        ended: 0,
      });
      const afterUpdate = await rowsWithPrefix(tx, prefix);
      expect(afterUpdate.map((r) => r.id)).toEqual(ids);
      expect(await historyCount(tx, ids)).toBe(1);
      const { rows: area } = await tx.execute<{ a: number }>(
        sql`select ST_Area(ST_Transform(geom, 32634)) as a from restricted_areas where source_ref = ${b.sourceRef}`,
      );
      expect(Number(area[0]!.a)).toBeCloseTo(300000, -2);

      expect(await upsertRestrictedAreas(tx, input([a, bChanged]))).toEqual({
        inserted: 0,
        updated: 0,
        unchanged: 2,
        ended: 1,
      });
      const afterEnd = await rowsWithPrefix(tx, prefix);
      expect(afterEnd.map((r) => [r.source_ref, r.valid_to])).toEqual([
        [`${prefix}a`, null],
        [`${prefix}b`, null],
        [`${prefix}c`, TODAY],
        [`${prefix}outside`, null],
      ]);

      expect(await upsertRestrictedAreas(tx, input([a, bChanged, c]))).toEqual({
        inserted: 1,
        updated: 0,
        unchanged: 2,
        ended: 0,
      });
      const cRows = (await rowsWithPrefix(tx, prefix)).filter((r) => r.source_ref === c.sourceRef);
      expect(cRows.map((r) => r.valid_to)).toEqual([TODAY, null]);
      expect(cRows[1]!.id).not.toBe(cRows[0]!.id);
    }));

  it("a kind change under the same sourceRef is an update of the same row", () =>
    withRollback(async (tx) => {
      const prefix = `test:kind-${crypto.randomUUID()}/`;
      const geometry = await utmRect(tx, 0, 0, 500, 500);
      const f: RestrictedFeature = { kind: "military", sourceRef: `${prefix}a`, geometry };
      const input = (features: RestrictedFeature[]) => ({ layerPrefix: prefix, box: BOX, features, today: TODAY });
      await upsertRestrictedAreas(tx, input([f]));
      const [before] = await rowsWithPrefix(tx, prefix);
      expect(await upsertRestrictedAreas(tx, input([{ ...f, kind: "aquaculture" }]))).toEqual({
        inserted: 0,
        updated: 1,
        unchanged: 0,
        ended: 0,
      });
      const rows = await rowsWithPrefix(tx, prefix);
      expect(rows.map((r) => r.id)).toEqual([before!.id]);
      expect(await historyCount(tx, [before!.id])).toBe(1);
      const { rows: kind } = await tx.execute<{ kind: string }>(sql`select kind from restricted_areas where id = ${before!.id}::uuid`);
      expect(kind[0]!.kind).toBe("aquaculture");
    }));

  it("rejects a feature whose sourceRef lacks the layer prefix", () =>
    withRollback(async (tx) => {
      const geometry = await utmRect(tx, 0, 0, 100, 100);
      await expect(
        upsertRestrictedAreas(tx, {
          layerPrefix: "test:layer/",
          box: BOX,
          features: [{ kind: "military", sourceRef: "other/1", geometry }],
          today: TODAY,
        }),
      ).rejects.toThrow(/prefix/);
    }));
});

describe("isAnchoringBan", () => {
  it.each<[RestrictedKind, string | null, boolean]>([
    ["military", null, true],
    ["aquaculture", "x/1", true],
    ["cable", "x/1", false],
    ["protected_area", "natura2000/GR4210001", true],
    ["protected_area", "natura2000/GR4210002", false],
    ["protected_area", "GR4210001", true],
    ["protected_area", null, false],
  ])("%s %s → %s", (kind, sourceRef, ban) => {
    expect(isAnchoringBan(kind, sourceRef, cfg(["GR4210001"]))).toBe(ban);
  });
});

describe("restrictionHits / exclusionFor", () => {
  it("anchor area 60 % in a military area → exclusion; 40 % → hit listed with share 0.4, no exclusion", () =>
    withRollback(async (tx) => {
      const area = await utmRect(tx, 0, 0, 1000, 1000);
      const position = await lonLatOf(tx, 500, 500);

      const sixty = await insertRestricted(tx, "military", await utmRect(tx, -100, -100, 600, 1100));
      const hits60 = await restrictionHits(tx, { area, position }, cfg());
      expect(hits60).toHaveLength(1);
      expect(hits60[0]).toMatchObject({ restrictedAreaId: sixty, kind: "military", sourceRef: null, anchoringBan: true });
      expect(hits60[0]!.share).toBeCloseTo(0.6, 2);
      expect(exclusionFor(hits60, 0.5)).toEqual(hits60[0]);

      await tx.update(restrictedAreas).set({ geom: sql`${geomFromGeoJson(await utmRect(tx, -100, -100, 400, 1100))}` })
        .where(eq(restrictedAreas.id, sixty));
      const hits40 = await restrictionHits(tx, { area, position }, cfg());
      expect(hits40).toHaveLength(1);
      expect(hits40[0]!.share).toBeCloseTo(0.4, 2);
      expect(exclusionFor(hits40, 0.5)).toBeNull();
    }));

  it("protected area: banned only if its site code is configured", () =>
    withRollback(async (tx) => {
      const area = await utmRect(tx, 0, 0, 1000, 1000);
      const position = await lonLatOf(tx, 500, 500);
      await insertRestricted(tx, "protected_area", await utmRect(tx, -100, -100, 1100, 1100), "natura2000/GR4210001");

      const unconfigured = await restrictionHits(tx, { area, position }, cfg());
      expect(unconfigured).toHaveLength(1);
      expect(unconfigured[0]).toMatchObject({ kind: "protected_area", anchoringBan: false });
      expect(unconfigured[0]!.share).toBeCloseTo(1, 3);
      expect(exclusionFor(unconfigured, 0.5)).toBeNull();

      const configured = await restrictionHits(tx, { area, position }, cfg(["GR4210001"]));
      expect(configured[0]).toMatchObject({ kind: "protected_area", anchoringBan: true });
      expect(exclusionFor(configured, 0.5)).toEqual(configured[0]);
    }));

  it("without anchor area the position decides (share 1)", () =>
    withRollback(async (tx) => {
      const cable = await insertRestricted(tx, "cable", await utmRect(tx, 0, 0, 1000, 1000));
      const military = await insertRestricted(tx, "military", await utmRect(tx, 400, 400, 600, 600));
      // Ended: ignored.
      const ended = await insertRestricted(tx, "aquaculture", await utmRect(tx, 0, 0, 1000, 1000));
      await tx.update(restrictedAreas).set({ validFrom: "2020-01-01", validTo: "2021-01-01" }).where(eq(restrictedAreas.id, ended));

      const inside = await restrictionHits(tx, { area: null, position: await lonLatOf(tx, 500, 500) }, cfg());
      expect(inside).toEqual([
        { restrictedAreaId: military, kind: "military", sourceRef: null, share: 1, anchoringBan: true },
        { restrictedAreaId: cable, kind: "cable", sourceRef: null, share: 1, anchoringBan: false },
      ]);
      expect(exclusionFor(inside, 0.5)?.restrictedAreaId).toBe(military);

      const outside = await restrictionHits(tx, { area: null, position: await lonLatOf(tx, 100, 100) }, cfg());
      expect(outside.map((h) => h.kind)).toEqual(["cable"]);
      expect(exclusionFor(outside, 0.5)).toBeNull();
    }));
});

describe("applyExclusion", () => {
  async function insertPlace(tx: Db, status: PlaceStatus, publicId: string | null = null): Promise<string> {
    const position = await lonLatOf(tx, 500, 500);
    const point: GeoJSON.Point = { type: "Point", coordinates: [position.lon, position.lat] };
    const [object] = await tx
      .insert(geoObjects)
      .values({ type: "bay", origin: "osm", geom: sql`${geomFromGeoJson(point)}`, tags: {} })
      .returning({ id: geoObjects.id });
    const [place] = await tx
      .insert(places)
      .values({ geoObjectId: object!.id, kind: "anchorage", status, publicId, position: sql`${geomFromGeoJson(point)}` })
      .returning({ id: places.id });
    return place!.id;
  }

  async function placeOf(tx: Db, id: string) {
    const [row] = await tx
      .select({ status: places.status, statusReason: places.statusReason, publicId: places.publicId })
      .from(places)
      .where(eq(places.id, id));
    return row;
  }

  async function taskStatus(tx: Db, placeId: string) {
    const rows = await tx
      .select({ status: reviewTasks.status })
      .from(reviewTasks)
      .where(and(eq(reviewTasks.kind, "place_candidate"), eq(reviewTasks.subjectId, placeId)));
    return rows.map((r) => r.status);
  }

  const hit: RestrictionHit = {
    restrictedAreaId: "00000000-0000-0000-0000-000000000001",
    kind: "military",
    sourceRef: null,
    share: 0.8,
    anchoringBan: true,
  };
  const reason = `restricted:military:${hit.restrictedAreaId}`;

  async function historyOf(tx: Db, id: string) {
    const { rows } = await tx.execute<{ old_row: { status: string; status_reason: string | null } }>(
      sql`select old_row from places_history where row_id = ${id}::uuid order by history_id`,
    );
    return rows.map((r) => r.old_row);
  }

  const restrictedTask = (tx: Db, id: string) =>
    tx
      .select({ status: reviewTasks.status, context: reviewTasks.context })
      .from(reviewTasks)
      .where(and(eq(reviewTasks.subjectId, id), sql`${reviewTasks.context}->>'reason' = 'restricted'`));

  it("candidate → excluded: no_anchoring, history row written, open task dismissed", () =>
    withRollback(async (tx) => {
      const candidate = await insertPlace(tx, "candidate");
      await createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId: candidate, context: {} });
      expect(await applyExclusion(tx, candidate, hit)).toBe("excluded");
      expect(await placeOf(tx, candidate)).toEqual({ status: "no_anchoring", statusReason: reason, publicId: null });
      expect(await taskStatus(tx, candidate)).toEqual(["dismissed"]);
      const history = await historyOf(tx, candidate);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ status: "candidate", status_reason: null });
      // Already excluded: no second change.
      expect(await applyExclusion(tx, candidate, hit)).toBe("unchanged");
    }));

  it("confirmed → unchanged place, a restricted review task is opened (once)", () =>
    withRollback(async (tx) => {
      const publicId = `sp_${crypto.randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase()}`;
      const confirmed = await insertPlace(tx, "confirmed", publicId);
      expect(await applyExclusion(tx, confirmed, hit)).toBe("review_opened");
      expect(await placeOf(tx, confirmed)).toEqual({ status: "confirmed", statusReason: null, publicId });
      expect(await historyOf(tx, confirmed)).toHaveLength(0);
      expect(await restrictedTask(tx, confirmed)).toEqual([
        {
          status: "open",
          context: {
            reason: "restricted",
            restriction: { kind: "military", id: hit.restrictedAreaId, share: 0.8 },
            previousStatus: "confirmed",
          },
        },
      ]);
      expect(await applyExclusion(tx, confirmed, hit)).toBe("unchanged");
      expect(await taskStatus(tx, confirmed)).toEqual(["open"]);
    }));

  it("the admin's decision on the restricted task is sticky", () =>
    withRollback(async (tx) => {
      const confirmed = await insertPlace(tx, "confirmed", `sp_${crypto.randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase()}`);
      expect(await applyExclusion(tx, confirmed, hit)).toBe("review_opened");
      const [task] = await tx
        .select({ id: reviewTasks.id })
        .from(reviewTasks)
        .where(and(eq(reviewTasks.subjectId, confirmed), eq(reviewTasks.status, "open")));
      await decideReviewTask(tx, {
        taskId: task!.id,
        decision: { action: "confirm", kind: "anchorage" },
        decidedBy: "admin@example.invalid",
      });
      expect(await applyExclusion(tx, confirmed, hit)).toBe("unchanged");
      expect((await restrictedTask(tx, confirmed)).map((t) => t.status)).toEqual(["decided"]);
      expect((await placeOf(tx, confirmed))?.status).toBe("confirmed");
    }));

  it("an earlier decided non-restricted task does not block the review task", () =>
    withRollback(async (tx) => {
      const confirmed = await insertPlace(tx, "confirmed", `sp_${crypto.randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase()}`);
      const { id } = await createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId: confirmed, context: {} });
      await tx.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.id, id));
      expect(await applyExclusion(tx, confirmed, hit)).toBe("review_opened");
    }));

  it("leaves rejected, review-decided no_anchoring, merged and ended places untouched", () =>
    withRollback(async (tx) => {
      const rejected = await insertPlace(tx, "rejected");
      await tx.update(places).set({ statusReason: "review" }).where(eq(places.id, rejected));
      expect(await applyExclusion(tx, rejected, hit)).toBe("unchanged");
      expect(await placeOf(tx, rejected)).toEqual({ status: "rejected", statusReason: "review", publicId: null });

      const noAnchoring = await insertPlace(tx, "no_anchoring");
      await tx.update(places).set({ statusReason: "review" }).where(eq(places.id, noAnchoring));
      expect(await applyExclusion(tx, noAnchoring, hit)).toBe("unchanged");
      expect(await placeOf(tx, noAnchoring)).toEqual({ status: "no_anchoring", statusReason: "review", publicId: null });

      const merged = await insertPlace(tx, "candidate");
      await tx.update(places).set({ mergedIntoId: noAnchoring }).where(eq(places.id, merged));
      expect(await applyExclusion(tx, merged, hit)).toBe("unchanged");
      expect((await placeOf(tx, merged))?.status).toBe("candidate");

      const ended = await insertPlace(tx, "candidate");
      await tx.update(places).set({ validTo: "2020-01-01" }).where(eq(places.id, ended));
      expect(await applyExclusion(tx, ended, hit)).toBe("unchanged");
      expect((await placeOf(tx, ended))?.status).toBe("candidate");
    }));
});
