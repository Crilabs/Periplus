import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, nameCandidates, places, restrictedAreas, reviewDecisions, reviewTasks, tiles } from "@/lib/db/schema";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { newId, newPublicId } from "@/lib/domain/ids";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { createReviewTask } from "@/lib/domain/review";
import { factFrom, pageFact, placeOf } from "@/test/confirmation";
import { insertComputation } from "@/test/consolidation";
import { withRollback } from "@/test/db";

/*
 * Kind switch by evidence during consolidation (spec 17 „Ortsart aus Belegen“, „Vorrang und Dauer“), through
 * `consolidateGeo` as the pipeline runs it. The old confirmation by evidence is switched off (plan N2 task 6).
 */

const placeRow = async (tx: Db, id: string) => (await tx.select().from(places).where(eq(places.id, id)))[0]!;

/** The decided pseudo tasks (`place_status`, `place_kind`) of the place with their decisions. */
async function autoDecisions(tx: Db, placeId: string) {
  return tx
    .select({ subjectType: reviewTasks.subjectType, status: reviewTasks.status, context: reviewTasks.context, decision: reviewDecisions.decision, decidedBy: reviewDecisions.decidedBy })
    .from(reviewTasks)
    .innerJoin(reviewDecisions, eq(reviewDecisions.taskId, reviewTasks.id))
    .where(and(eq(reviewTasks.subjectId, placeId), inArray(reviewTasks.subjectType, ["place_status", "place_kind"])))
    .orderBy(reviewTasks.subjectType);
}

const seedTask = (tx: Db, placeId: string, objectId: string, kind = "anchorage") =>
  createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId: placeId, context: { geoObjectId: objectId, kind, tileId: null, name: "Kolona" } });

const taskRow = async (tx: Db, id: string) => (await tx.select().from(reviewTasks).where(eq(reviewTasks.id, id)))[0]!;

describe("applyAutoStatus (in consolidateGeo)", () => {
  it("a pilot guide's anchoring fact no longer confirms a candidate: no decision, the seed task stays open (plan N2 task 6)", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      const seed = await seedTask(tx, place.placeId, place.objectId);
      await factFrom(tx, place.objectId, { docType: "pilot_guide" });
      await factFrom(tx, place.objectId, { docType: "pilot_guide" });
      await consolidateGeo(tx, place.objectId);

      expect(await placeRow(tx, place.placeId)).toMatchObject({ status: "candidate", statusReason: null, publicId: null, kind: "anchorage" });
      expect(await autoDecisions(tx, place.placeId)).toEqual([]);
      expect((await taskRow(tx, seed.id)).status).toBe("open");
    }));

  it("one trip report leaves the place a candidate with its seed task open", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      const seed = await seedTask(tx, place.placeId, place.objectId);
      await factFrom(tx, place.objectId);
      await consolidateGeo(tx, place.objectId);
      expect(await placeRow(tx, place.placeId)).toMatchObject({ status: "candidate", publicId: null });
      expect(await autoDecisions(tx, place.placeId)).toEqual([]);
      expect((await taskRow(tx, seed.id)).status).toBe("open");
    }));

  it("a candidate inside a restricted area with evidence is no longer set no_anchoring from text (plan N2 task 6)", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      await factFrom(tx, place.objectId, { docType: "pilot_guide" });
      const square: GeoJSON.Polygon = { type: "Polygon", coordinates: [[[20.99, 35.19], [21.01, 35.19], [21.01, 35.21], [20.99, 35.21], [20.99, 35.19]]] };
      const [area] = await tx.insert(restrictedAreas).values({ kind: "military", geom: sql`${geomFromGeoJson(square)}` }).returning({ id: restrictedAreas.id });
      await insertComputation(tx, place.objectId, "restriction", {
        prohibitions: [{ kind: "military", restrictedAreaId: area!.id, sourceRef: null, share: 1, anchoringBan: true }],
      });
      await consolidateGeo(tx, place.objectId);

      expect(await placeRow(tx, place.placeId)).toMatchObject({ status: "candidate", publicId: null });
      expect(await autoDecisions(tx, place.placeId)).toEqual([]);
    }));

  it("rejected, no_anchoring and abandoned places never change status by new evidence", () =>
    withRollback(async (tx) => {
      for (const status of ["rejected", "no_anchoring", "abandoned"] as const) {
        const place = await placeOf(tx, { status });
        await factFrom(tx, place.objectId, { docType: "pilot_guide" });
        await consolidateGeo(tx, place.objectId);
        expect((await placeRow(tx, place.placeId)).status, status).toBe(status);
        expect(await autoDecisions(tx, place.placeId)).toEqual([]);
      }
    }));

  it("rejected, no_anchoring and abandoned places never switch kind; a confirmed one does (final review 5)", () =>
    withRollback(async (tx) => {
      for (const status of ["rejected", "no_anchoring", "abandoned"] as const) {
        const place = await placeOf(tx, { status, kind: "marina" });
        await factFrom(tx, place.objectId, { attribute: "place.kind_evidence", value: "anchorage" });
        await consolidateGeo(tx, place.objectId);
        expect(await placeRow(tx, place.placeId), status).toMatchObject({ status, kind: "marina" });
        expect(await autoDecisions(tx, place.placeId)).toEqual([]);
      }
      const confirmed = await placeOf(tx, { status: "confirmed", kind: "marina", publicId: newPublicId("sp") });
      await factFrom(tx, confirmed.objectId, { attribute: "place.kind_evidence", value: "anchorage" });
      await consolidateGeo(tx, confirmed.objectId);
      expect(await placeRow(tx, confirmed.placeId)).toMatchObject({ status: "confirmed", kind: "anchorage" });
    }));

  it("place.kind_evidence port turns a seed marina into a port (place_kind decision); the status stays (plan N2 task 6)", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx, { kind: "marina" });
      await seedTask(tx, place.placeId, place.objectId, "marina");
      const k = await factFrom(tx, place.objectId, { attribute: "place.kind_evidence", value: "port" });
      await consolidateGeo(tx, place.objectId);

      expect(await placeRow(tx, place.placeId)).toMatchObject({ kind: "port", status: "candidate" });
      expect(await autoDecisions(tx, place.placeId)).toEqual([
        {
          subjectType: "place_kind",
          status: "decided",
          context: { previous: "marina" },
          decision: { action: "set_kind", kind: "port", auto: true, factIds: [k.factId] },
          decidedBy: "system",
        },
      ]);
    }));

  it("a kind the admin chose against the seed proposal is never switched; one that took the proposal is", () =>
    withRollback(async (tx) => {
      const admin = await placeOf(tx, { kind: "marina", status: "confirmed", publicId: newPublicId("sp") });
      const chosen = await seedTask(tx, admin.placeId, admin.objectId, "anchorage");
      await tx.insert(reviewDecisions).values({ taskId: chosen.id, decision: { action: "confirm", kind: "marina" }, decidedBy: "admin@test.invalid" });
      await tx.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.id, chosen.id));
      await factFrom(tx, admin.objectId, { attribute: "place.kind_evidence", value: "port" });
      await consolidateGeo(tx, admin.objectId);
      expect((await placeRow(tx, admin.placeId)).kind).toBe("marina");
      expect(await autoDecisions(tx, admin.placeId)).toEqual([]);

      const proposal = await placeOf(tx, { kind: "marina", status: "confirmed", publicId: newPublicId("sp") });
      const taken = await seedTask(tx, proposal.placeId, proposal.objectId, "marina");
      await tx.insert(reviewDecisions).values({ taskId: taken.id, decision: { action: "confirm", kind: "marina" }, decidedBy: "admin@test.invalid" });
      await tx.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.id, taken.id));
      await factFrom(tx, proposal.objectId, { attribute: "place.kind_evidence", value: "port" });
      await consolidateGeo(tx, proposal.objectId);
      expect(await placeRow(tx, proposal.placeId)).toMatchObject({ kind: "port", status: "confirmed" });
    }));

  it("after an automatic switch the open seed task proposes the new kind: the seed kind locks, the default does not (final review 1)", () =>
    withRollback(async (tx) => {
      // admin picks the seed's old kind against the switched one → locked, never switched back
      const back = await placeOf(tx, { kind: "marina" });
      const backSeed = await seedTask(tx, back.placeId, back.objectId, "marina");
      await factFrom(tx, back.objectId, { attribute: "place.kind_evidence", value: "anchorage" });
      await consolidateGeo(tx, back.objectId);
      expect(await placeRow(tx, back.placeId)).toMatchObject({ kind: "anchorage", status: "candidate" });
      const backTask = await taskRow(tx, backSeed.id);
      expect(backTask).toMatchObject({ status: "open", context: expect.objectContaining({ kind: "anchorage" }) });
      await decideReviewTask(tx, { taskId: backSeed.id, decision: { action: "confirm", kind: "marina" }, decidedBy: "admin@test.invalid" });
      await consolidateGeo(tx, back.objectId);
      expect(await placeRow(tx, back.placeId)).toMatchObject({ kind: "marina", status: "confirmed" });

      // admin takes the default (the switched kind) → not locked, later evidence may switch it
      const taken = await placeOf(tx, { kind: "marina" });
      const takenSeed = await seedTask(tx, taken.placeId, taken.objectId, "marina");
      await factFrom(tx, taken.objectId, { attribute: "place.kind_evidence", value: "anchorage", observedAt: "2026-10-01" });
      await consolidateGeo(tx, taken.objectId);
      await decideReviewTask(tx, { taskId: takenSeed.id, decision: { action: "confirm", kind: "anchorage" }, decidedBy: "admin@test.invalid" });
      await consolidateGeo(tx, taken.objectId);
      expect((await placeRow(tx, taken.placeId)).kind).toBe("anchorage");
      await factFrom(tx, taken.objectId, { attribute: "place.kind_evidence", value: "mooring_field", observedAt: "2026-10-15" });
      await consolidateGeo(tx, taken.objectId);
      expect((await placeRow(tx, taken.placeId)).kind).toBe("mooring_field");
    }));

  it("only documents whose type counts switch a kind: no dataset, no neighbour's marina page; the bound own site does (fix round 1)", () =>
    withRollback(async (tx) => {
      const dataset = await placeOf(tx, { kind: "marina" });
      await factFrom(tx, dataset.objectId, { docType: "dataset", attribute: "place.kind_evidence", value: "port" });
      await consolidateGeo(tx, dataset.objectId);
      expect(await placeRow(tx, dataset.placeId)).toMatchObject({ kind: "marina", status: "candidate" });

      const neighbour = await placeOf(tx, { kind: "marina" });
      await pageFact(tx, neighbour.objectId, { bound: false, attribute: "place.kind_evidence", value: "port" });
      await consolidateGeo(tx, neighbour.objectId);
      expect(await placeRow(tx, neighbour.placeId)).toMatchObject({ kind: "marina", status: "candidate" });
      expect(await autoDecisions(tx, neighbour.placeId)).toEqual([]);

      const own = await placeOf(tx, { kind: "marina" });
      await pageFact(tx, own.objectId, { bound: true, attribute: "place.kind_evidence", value: "port" });
      await consolidateGeo(tx, own.objectId);
      expect(await placeRow(tx, own.placeId)).toMatchObject({ kind: "port", status: "candidate" });
    }));

  it("the kind of a place an admin created („Ort anlegen“, create_place) is never switched (fix round 1)", () =>
    withRollback(async (tx) => {
      const tileId = tileIdFor(21.0, 35.2);
      const [w, s, e, n] = tileBbox(tileId);
      await tx.insert(tiles).values({ id: tileId, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, hasCoast: true }).onConflictDoNothing();
      const name = `Adminhafen ${newId().slice(-6)}`;
      const [candidate] = await tx
        .insert(nameCandidates)
        .values({ nameNormalized: name.toLowerCase(), displayName: name, hint: "harbour", tileId, status: "review", documents: 2, sources: 2 })
        .returning({ id: nameCandidates.id });
      const task = await createReviewTask(tx, { kind: "place_candidate", subjectType: "name_candidate", subjectId: candidate!.id, context: { name, tileId } });
      await decideReviewTask(tx, {
        taskId: task.id,
        decision: { action: "create_place", kind: "marina", position: { lon: 21.0, lat: 35.2 }, name, language: "en" },
        decidedBy: "admin@test.invalid",
      });
      const [created] = await tx
        .select({ objectId: places.geoObjectId, placeId: places.id })
        .from(places)
        .innerJoin(geoNames, eq(geoNames.geoObjectId, places.geoObjectId))
        .where(and(eq(geoNames.name, name), eq(geoNames.origin, "text")));
      expect(await placeRow(tx, created!.placeId)).toMatchObject({ kind: "marina", status: "confirmed" });

      await factFrom(tx, created!.objectId, { docType: "pilot_guide", attribute: "place.kind_evidence", value: "port" });
      await consolidateGeo(tx, created!.objectId);
      expect((await placeRow(tx, created!.placeId)).kind).toBe("marina");
      expect(await autoDecisions(tx, created!.placeId)).toEqual([]);
    }));
});
