import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { documents, geoNames, nameCandidates, places, restrictedAreas, reviewDecisions, reviewTasks, tiles } from "@/lib/db/schema";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { newId, newPublicId } from "@/lib/domain/ids";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { createReviewTask } from "@/lib/domain/review";
import { factFrom, pageFact, placeOf } from "@/test/confirmation";
import { insertComputation } from "@/test/consolidation";
import { withRollback } from "@/test/db";

/*
 * Confirmation and kind switch by evidence during consolidation (spec 17 „Bestätigung nach Beleg“, „Ortsart aus
 * Belegen“, „Vorrang und Dauer“), through `consolidateGeo` as the pipeline runs it.
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
  it("a pilot guide's anchoring fact confirms a candidate: rule alone, decided by system, sp_ id, seed task dismissed", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      const seed = await seedTask(tx, place.placeId, place.objectId);
      const f = await factFrom(tx, place.objectId, { docType: "pilot_guide" });
      await consolidateGeo(tx, place.objectId);

      const row = await placeRow(tx, place.placeId);
      expect(row).toMatchObject({ status: "confirmed", statusReason: null, kind: "anchorage" });
      expect(row.publicId).toMatch(/^sp_/);
      expect(await autoDecisions(tx, place.placeId)).toEqual([
        {
          subjectType: "place_status",
          status: "decided",
          context: { previous: "candidate" },
          decision: { action: "confirm", auto: true, rule: "alone", factIds: [f.factId], documentIds: [f.documentId], routeStopIds: [] },
          decidedBy: "system",
        },
      ]);
      expect(await taskRow(tx, seed.id)).toMatchObject({ status: "dismissed", context: expect.objectContaining({ dismissedReason: "auto_confirmed" }) });
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

  it("an open pair review waits, also when the place's object is the larger id (Review Focus 4); the pair task stays", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      await factFrom(tx, place.objectId, { docType: "pilot_guide" });
      // the place's object as the larger id of the pair
      const subjectId = `00000000-0000-4000-8000-000000000000:${place.objectId}`;
      const pair = await createReviewTask(tx, { kind: "place_candidate", subjectType: "geo_object_pair", subjectId, context: {} });
      await consolidateGeo(tx, place.objectId);
      expect((await placeRow(tx, place.placeId)).status).toBe("candidate");
      expect((await taskRow(tx, pair.id)).status).toBe("open");

      // decided: the next consolidation confirms
      await tx.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.id, pair.id));
      await consolidateGeo(tx, place.objectId);
      expect((await placeRow(tx, place.placeId)).status).toBe("confirmed");
    }));

  it("a candidate inside a restricted area becomes no_anchoring with an sp_ id", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      const f = await factFrom(tx, place.objectId, { docType: "pilot_guide" });
      const square: GeoJSON.Polygon = { type: "Polygon", coordinates: [[[20.99, 35.19], [21.01, 35.19], [21.01, 35.21], [20.99, 35.21], [20.99, 35.19]]] };
      const [area] = await tx.insert(restrictedAreas).values({ kind: "military", geom: sql`${geomFromGeoJson(square)}` }).returning({ id: restrictedAreas.id });
      await insertComputation(tx, place.objectId, "restriction", {
        prohibitions: [{ kind: "military", restrictedAreaId: area!.id, sourceRef: null, share: 1, anchoringBan: true }],
      });
      await consolidateGeo(tx, place.objectId);

      const row = await placeRow(tx, place.placeId);
      expect(row).toMatchObject({ status: "no_anchoring", statusReason: `restricted:military:${area!.id}` });
      expect(row.publicId).toMatch(/^sp_/);
      expect(await autoDecisions(tx, place.placeId)).toEqual([
        expect.objectContaining({
          subjectType: "place_status",
          decision: { action: "no_anchoring", auto: true, rule: "alone", factIds: [f.factId], documentIds: [f.documentId], routeStopIds: [] },
          decidedBy: "system",
        }),
      ]);
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

  it("a confirmed place whose only evidence document is gone stays confirmed (Review Focus 5)", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      const f = await factFrom(tx, place.objectId, { docType: "pilot_guide" });
      await consolidateGeo(tx, place.objectId);
      const confirmed = await placeRow(tx, place.placeId);
      expect(confirmed.status).toBe("confirmed");

      await tx.update(documents).set({ status: "gone" }).where(eq(documents.id, f.documentId));
      await consolidateGeo(tx, place.objectId);
      expect(await placeRow(tx, place.placeId)).toMatchObject({ status: "confirmed", publicId: confirmed.publicId });
      expect(await autoDecisions(tx, place.placeId)).toHaveLength(1);
    }));

  it("place.kind_evidence port turns a seed marina into a port (place_kind decision) and confirms it as commercial", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx, { kind: "marina" });
      await seedTask(tx, place.placeId, place.objectId, "marina");
      const k = await factFrom(tx, place.objectId, { attribute: "place.kind_evidence", value: "port" });
      await consolidateGeo(tx, place.objectId);

      expect(await placeRow(tx, place.placeId)).toMatchObject({ kind: "port", status: "confirmed" });
      expect(await autoDecisions(tx, place.placeId)).toEqual([
        {
          subjectType: "place_kind",
          status: "decided",
          context: { previous: "marina" },
          decision: { action: "set_kind", kind: "port", auto: true, factIds: [k.factId] },
          decidedBy: "system",
        },
        expect.objectContaining({ subjectType: "place_status", decision: expect.objectContaining({ action: "confirm", rule: "commercial_port" }) }),
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
      expect(await placeRow(tx, own.placeId)).toMatchObject({ kind: "port", status: "confirmed" });
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
