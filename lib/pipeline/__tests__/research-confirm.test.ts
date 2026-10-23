import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  berthSignals,
  documents,
  pageAssessments,
  places,
  researchHits,
  researchRouteStops,
  researchUnits,
  restrictedAreas,
  reviewDecisions,
  reviewTasks,
  serpQueries,
  serpResults,
  type BerthSignalKind,
  type PageKind,
} from "@/lib/db/schema";
import { newId, newPublicId } from "@/lib/domain/ids";
import { setPlaceStatusByAdmin } from "@/lib/domain/place-status";
import { createReviewTask } from "@/lib/domain/review";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { activeRouteExtractor } from "@/lib/domain/research/assign";
import { applyBerthVerdicts, loadEvidence } from "@/lib/domain/research/confirmation";
import { createRun } from "@/lib/domain/runs";
import { activeExtractor } from "@/lib/pipeline/research/extract";
import { confirmBerths, planResearchConfirm, RESEARCH_CONFIRM_STAGE } from "@/lib/pipeline/research/confirm";
import { insertComputation } from "@/test/consolidation";
import { placeOf } from "@/test/confirmation";
import { withRollback } from "@/test/db";
import { insertTestRun, insertTestSource, insertTestVersion } from "@/test/text";

/*
 * `applyBerthVerdicts` and the stage `research.confirm` (plan N2 task 6, spec 5.6) against real Postgres: signals
 * loaded per place, status set and recorded as a system decision, admin and final statuses left alone.
 */

const config: AppConfig = loadConfig("config");
const NOW = new Date("2026-10-23T12:00:00Z");

type PageOpts = {
  domain: string;
  kind?: BerthSignalKind;
  firstHand?: boolean;
  confidence?: number;
  observedAt?: string;
  pageKind?: PageKind;
  /** How the page is linked to the place: a search hit (default), a route stop matched by name or by the corridor, or none. */
  link?: "search" | "name" | "corridor" | "none";
  unitStatus?: "done" | "failed";
  unitModel?: string;
};

/** One page of `domain` with an active assessment, a research unit of the place and one signal in it. */
async function signalPage(tx: Db, place: { placeId: string; objectId: string }, o: PageOpts): Promise<{ signalId: string; versionId: string }> {
  const sourceId = await insertTestSource(tx);
  const url = `https://www.${o.domain}/${newId()}`;
  const [doc] = await tx.insert(documents).values({ sourceId, url, urlNormalized: url, docType: "trip_report" }).returning({ id: documents.id });
  const { versionId } = await insertTestVersion(tx, ["x"], { documentId: doc!.id });
  const assessor = activeAssessor(config);
  await tx.insert(pageAssessments).values({
    documentVersionId: versionId, model: assessor.model, promptVersion: assessor.promptVersion, pageKind: o.pageKind ?? "trip_report", firstHand: true,
    generated: false, observedAt: o.observedAt ?? "2024-06-15", observedAtBasis: "explicit", berths: [], runId: await insertTestRun(tx),
  });
  const link = o.link ?? "search";
  if (link === "search") {
    const [q] = await tx
      .insert(serpQueries)
      .values({ keyword: "k", languageCode: "en", locationCode: 2300, depth: 10, level: "place", scopeId: place.objectId, rawKey: `serp/x/${url}.json`, fetchedAt: new Date() })
      .returning({ id: serpQueries.id });
    const [r] = await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url, urlNormalized: url, domain: o.domain, title: "t", snippet: "s" }).returning({ id: serpResults.id });
    await tx.insert(researchHits).values({ placeId: place.placeId, geoObjectId: place.objectId, serpQueryId: q!.id, serpResultId: r!.id, urlNormalized: url, domain: o.domain, rank: 1, purpose: "positive" });
  } else if (link !== "none") {
    const route = activeRouteExtractor(config);
    await tx.insert(researchRouteStops).values({
      documentVersionId: versionId, seq: 1, name: "Bay", quote: "q", observedAt: o.observedAt ?? "2024-06-15", placeId: place.placeId, match: link, model: route.model, promptVersion: route.promptVersion,
    });
  }
  const extractor = activeExtractor(config);
  const [unit] = await tx
    .insert(researchUnits)
    .values({ documentVersionId: versionId, placeId: place.placeId, model: o.unitModel ?? extractor.model, promptVersion: extractor.promptVersion, status: o.unitStatus ?? "done", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 0 } })
    .returning({ id: researchUnits.id });
  const [signal] = await tx
    .insert(berthSignals)
    .values({
      unitId: unit!.id, placeId: place.placeId, documentVersionId: versionId, kind: o.kind ?? "anchored", firstHand: o.firstHand ?? true, confidence: o.confidence ?? 0.9,
      quote: "We anchored here", quoteStart: 0, quoteEnd: 16, observedAt: o.observedAt ?? "2024-06-15", observedAtBasis: "explicit",
    })
    .returning({ id: berthSignals.id });
  return { signalId: signal!.id, versionId };
}

const placeRow = async (tx: Db, id: string) => (await tx.select().from(places).where(eq(places.id, id)))[0]!;

async function statusDecisions(tx: Db, placeId: string) {
  return tx
    .select({ context: reviewTasks.context, decision: reviewDecisions.decision, decidedBy: reviewDecisions.decidedBy })
    .from(reviewTasks)
    .innerJoin(reviewDecisions, eq(reviewDecisions.taskId, reviewTasks.id))
    .where(and(eq(reviewTasks.subjectId, placeId), eq(reviewTasks.subjectType, "place_status")))
    .orderBy(reviewDecisions.decidedAt);
}

describe("applyBerthVerdicts", () => {
  it("a candidate with two independent sources is confirmed with a public id and a system decision", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      const a = await signalPage(tx, place, { domain: "sail-a.example" });
      const b = await signalPage(tx, place, { domain: "sail-b.example", link: "name" });

      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([{ placeId: place.placeId, from: "candidate", to: "confirmed" }]);
      const row = await placeRow(tx, place.placeId);
      expect(row).toMatchObject({ status: "confirmed", statusReason: null });
      expect(row.publicId).toMatch(/^sp_/);
      expect(await statusDecisions(tx, place.placeId)).toEqual([
        {
          context: { previous: "candidate" },
          decision: {
            action: "confirm", auto: true, rule: "research", reason: "2 unabhängige Quellen: sail-a.example, sail-b.example",
            sources: ["sail-a.example", "sail-b.example"], signalIds: [a.signalId, b.signalId].sort(), blockingSignalId: null,
          },
          decidedBy: "system",
        },
      ]);
      // idempotent: a second pass changes nothing
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([]);
      expect(await statusDecisions(tx, place.placeId)).toHaveLength(1);
    }));

  it("five pages of one domain leave a candidate with the reason at the place (Review Focus)", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      for (let i = 0; i < 5; i++) await signalPage(tx, place, { domain: "sail-a.example" });
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([]);
      expect(await placeRow(tx, place.placeId)).toMatchObject({ status: "candidate", statusReason: "1 von 2 unabhängigen Quellen", publicId: null });
      expect(await statusDecisions(tx, place.placeId)).toEqual([]);
    }));

  it("a place confirmed before without research evidence goes back to candidate, keeping its public id", () =>
    withRollback(async (tx) => {
      const publicId = newPublicId("sp");
      const place = await placeOf(tx, { status: "confirmed", publicId });
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([{ placeId: place.placeId, from: "confirmed", to: "candidate" }]);
      expect(await placeRow(tx, place.placeId)).toMatchObject({ status: "candidate", statusReason: "0 von 2 unabhängigen Quellen", publicId });
      expect(await statusDecisions(tx, place.placeId)).toEqual([
        expect.objectContaining({ context: { previous: "confirmed" }, decision: expect.objectContaining({ action: "candidate", auto: true, rule: "research" }), decidedBy: "system" }),
      ]);
    }));

  it("a younger prohibition by the authority withdraws a confirmation: no_anchoring with the reason (Review Focus)", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      for (const [i, d] of ["a", "b", "c"].entries()) await signalPage(tx, place, { domain: `${d}.example`, observedAt: `202${i + 2}-07-01` });
      await applyBerthVerdicts(tx, [place.placeId], NOW, config);
      expect((await placeRow(tx, place.placeId)).status).toBe("confirmed");

      const ban = await signalPage(tx, place, { domain: "port-police.example", kind: "prohibited", firstHand: false, pageKind: "authority", observedAt: "2025-06-01" });
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([{ placeId: place.placeId, from: "confirmed", to: "no_anchoring" }]);
      expect(await placeRow(tx, place.placeId)).toMatchObject({ status: "no_anchoring", statusReason: "Ankerverbot laut Behörde (2025-06-01)" });
      const decisions = await statusDecisions(tx, place.placeId);
      expect(decisions.at(-1)!.decision).toMatchObject({ action: "no_anchoring", rule: "research", blockingSignalId: ban.signalId });
    }));

  it("rejected and abandoned places and a status an admin set stay as they are", () =>
    withRollback(async (tx) => {
      for (const status of ["rejected", "abandoned"] as const) {
        const place = await placeOf(tx, { status });
        await signalPage(tx, place, { domain: "a.example" });
        await signalPage(tx, place, { domain: "b.example" });
        expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([]);
        expect((await placeRow(tx, place.placeId)).status).toBe(status);
      }
      // the admin confirmed it without any research evidence: it stays confirmed
      const admin = await placeOf(tx);
      await setPlaceStatusByAdmin(tx, { placeId: admin.placeId, status: "confirmed", from: "candidate", decidedBy: "admin@test.invalid" });
      expect(await applyBerthVerdicts(tx, [admin.placeId], NOW, config)).toEqual([]);
      expect((await placeRow(tx, admin.placeId)).status).toBe("confirmed");
      // a no_anchoring the rule did not set (here: the admin's) is left alone, too
      const excluded = await placeOf(tx);
      await setPlaceStatusByAdmin(tx, { placeId: excluded.placeId, status: "no_anchoring", from: "candidate", decidedBy: "admin@test.invalid" });
      await signalPage(tx, excluded, { domain: "a.example" });
      await signalPage(tx, excluded, { domain: "b.example" });
      expect(await applyBerthVerdicts(tx, [excluded.placeId], NOW, config)).toEqual([]);
      expect((await placeRow(tx, excluded.placeId)).status).toBe("no_anchoring");
    }));

  it("a no_anchoring of a seed (restricted, no decision) stays", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx, { status: "no_anchoring" });
      await signalPage(tx, place, { domain: "a.example" });
      await signalPage(tx, place, { domain: "b.example" });
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([]);
      expect((await placeRow(tx, place.placeId)).status).toBe("no_anchoring");
    }));

  it("a candidate inside a restricted area is not confirmed: it becomes no_anchoring by the area", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      await signalPage(tx, place, { domain: "a.example" });
      await signalPage(tx, place, { domain: "b.example" });
      const square: GeoJSON.Polygon = { type: "Polygon", coordinates: [[[20.99, 35.19], [21.01, 35.19], [21.01, 35.21], [20.99, 35.21], [20.99, 35.19]]] };
      const [area] = await tx.insert(restrictedAreas).values({ kind: "military", geom: sql`${geomFromGeoJson(square)}` }).returning({ id: restrictedAreas.id });
      await insertComputation(tx, place.objectId, "restriction", {
        prohibitions: [{ kind: "military", restrictedAreaId: area!.id, sourceRef: null, share: 1, anchoringBan: true }],
      });
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([{ placeId: place.placeId, from: "candidate", to: "no_anchoring" }]);
      const row = await placeRow(tx, place.placeId);
      expect(row).toMatchObject({ status: "no_anchoring", statusReason: `restricted:military:${area!.id}` });
      expect(row.publicId).toMatch(/^sp_/);
      expect((await statusDecisions(tx, place.placeId))[0]!.decision).toMatchObject({ action: "no_anchoring", rule: "research", reason: "Sperrgebiet" });
    }));

  it("an open duplicate review holds the confirmation; once decided, it confirms and dismisses the seed task", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      await signalPage(tx, place, { domain: "a.example" });
      await signalPage(tx, place, { domain: "b.example" });
      const seed = await createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId: place.placeId, context: { geoObjectId: place.objectId, kind: "anchorage", tileId: null, name: "Kolona" } });
      const pair = await createReviewTask(tx, { kind: "place_candidate", subjectType: "geo_object_pair", subjectId: `00000000-0000-4000-8000-000000000000:${place.objectId}`, context: {} });
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([]);
      expect(await placeRow(tx, place.placeId)).toMatchObject({ status: "candidate", statusReason: expect.stringMatching(/^offene Dubletten-Prüfung/) });

      await tx.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.id, pair.id));
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([{ placeId: place.placeId, from: "candidate", to: "confirmed" }]);
      const [task] = await tx.select().from(reviewTasks).where(eq(reviewTasks.id, seed.id));
      expect(task).toMatchObject({ status: "dismissed", context: expect.objectContaining({ dismissedReason: "auto_confirmed" }) });
    }));

  it("pages linked only by a route corridor do not confirm; one search-linked source opens them (ruling)", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      await signalPage(tx, place, { domain: "a.example", link: "corridor" });
      await signalPage(tx, place, { domain: "b.example", link: "corridor" });
      expect((await loadEvidence(tx, [place.placeId], config)).get(place.placeId)!.map((e) => e.link)).toEqual(["corridor", "corridor"]);
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([]);
      expect(await placeRow(tx, place.placeId)).toMatchObject({ status: "candidate", statusReason: "nur über Routen-Korridor gefunden" });

      await signalPage(tx, place, { domain: "c.example", link: "search" });
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([{ placeId: place.placeId, from: "candidate", to: "confirmed" }]);
    }));

  it("a corridor-linked page whose assessed berths name the place counts as name-linked", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx); // named „Kolona“
      const { versionId } = await signalPage(tx, place, { domain: "a.example", link: "corridor" });
      await tx.update(pageAssessments).set({ berths: [{ name: "Kolona", island: null, kind: "anchorage" }] }).where(eq(pageAssessments.documentVersionId, versionId));
      expect((await loadEvidence(tx, [place.placeId], config)).get(place.placeId)!.map((e) => e.link)).toEqual(["name"]);
    }));

  it("only signals of done units of the active extract-berth model count; the page's active assessment decides its kind", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      await signalPage(tx, place, { domain: "a.example" });
      await signalPage(tx, place, { domain: "b.example", unitStatus: "failed" });
      await signalPage(tx, place, { domain: "c.example", unitModel: "old-model" });
      const evidence = (await loadEvidence(tx, [place.placeId], config)).get(place.placeId)!;
      expect(evidence).toEqual([expect.objectContaining({ domain: "a.example", pageKind: "trip_report", generated: false, link: "search", confidence: 0.9 })]);
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([]);
    }));
});

describe("research.confirm stage", () => {
  it("plans one job and confirms the run's candidates", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      await signalPage(tx, place, { domain: "a.example" });
      await signalPage(tx, place, { domain: "b.example" });
      const { id } = await createRun(tx, {
        kind: "reprocess",
        scope: { type: "system", id: `confirm-${newId()}` },
        stages: [RESEARCH_CONFIRM_STAGE],
        params: { placeIds: [place.placeId] },
        triggeredBy: "test",
      });
      expect(await planResearchConfirm()).toEqual([{ key: "confirm" }]);
      const result = await confirmBerths(tx, { runId: id, stage: RESEARCH_CONFIRM_STAGE, key: "confirm" }, config, NOW);
      expect(result).toEqual([{ placeId: place.placeId, from: "candidate", to: "confirmed" }]);
      expect((await tx.select({ status: places.status }).from(places).where(inArray(places.id, [place.placeId])))[0]!.status).toBe("confirmed");
    }));
});
