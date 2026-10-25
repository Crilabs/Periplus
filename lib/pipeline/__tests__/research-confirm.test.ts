import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  pageAssessments,
  places,
  restrictedAreas,
  reviewDecisions,
  reviewTasks,
  sources,
} from "@/lib/db/schema";
import { newId, newPublicId } from "@/lib/domain/ids";
import { setPlaceStatusByAdmin } from "@/lib/domain/place-status";
import { createReviewTask } from "@/lib/domain/review";
import { recordDecision } from "@/lib/domain/review/system-decisions";
import { applyBerthVerdicts, loadEvidence } from "@/lib/domain/research/confirmation";
import { createRun } from "@/lib/domain/runs";
import { confirmBerths, planResearchConfirm, RESEARCH_CONFIRM_STAGE, researchChanges } from "@/lib/pipeline/research/confirm";
import { insertComputation } from "@/test/consolidation";
import { placeOf } from "@/test/confirmation";
import { withRollback } from "@/test/db";
import { insertTestVersion } from "@/test/text";
import { signalPage as sharedSignalPage, type SignalPageOpts } from "@/test/research-signals";

/*
 * `applyBerthVerdicts` and the stage `research.confirm` (plan N2 task 6, spec 5.6) against real Postgres: signals
 * loaded per place, status set and recorded as a system decision, admin and final statuses left alone.
 */

const config: AppConfig = loadConfig("config");
const NOW = new Date("2026-10-23T12:00:00Z");

const signalPage = (tx: Db, place: { placeId: string; objectId: string }, o: SignalPageOpts) => sharedSignalPage(tx, config, place, o);

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
            runId: null,
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

  it("a younger negative from a forum, dated by its fetch, withdraws a confirmation (Review Focus „Abrufdatum“)", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      await signalPage(tx, place, { domain: "a.example", observedAt: "2023-07-01" });
      await signalPage(tx, place, { domain: "b.example", observedAt: "2024-07-01" });
      await applyBerthVerdicts(tx, [place.placeId], NOW, config);
      const { publicId } = await placeRow(tx, place.placeId);
      expect(publicId).toMatch(/^sp_/);

      const neg = await signalPage(tx, place, { domain: "forum.example", kind: "buoys_private", firstHand: false, pageKind: "forum", observedAt: "2026-10-19", observedAtBasis: "fetched" });
      expect((await loadEvidence(tx, [place.placeId], config)).get(place.placeId)!.find((e) => e.signalId === neg.signalId)).toMatchObject({ observedAtBasis: "fetched" });
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([{ placeId: place.placeId, from: "confirmed", to: "candidate" }]);
      expect(await placeRow(tx, place.placeId)).toMatchObject({ status: "candidate", statusReason: "jüngerer Negativbeleg: Bojen privat (forum.example, 2026-10-19)", publicId });
      expect((await statusDecisions(tx, place.placeId)).at(-1)!.decision).toMatchObject({ action: "candidate", rule: "research", blockingSignalId: neg.signalId });
    }));

  it("a no_anchoring place is never re-decided, also one this rule set, whatever the evidence", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx, { status: "no_anchoring" });
      await recordDecision(tx, place.placeId, "place_status", "candidate", { action: "no_anchoring", auto: true, rule: "research" }, new Date("2026-01-01T00:00:00Z"));
      for (const d of ["a", "b", "c"]) await signalPage(tx, place, { domain: `${d}.example`, observedAt: "2026-06-01" });
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([]);
      expect((await placeRow(tx, place.placeId)).status).toBe("no_anchoring");
      expect(await statusDecisions(tx, place.placeId)).toHaveLength(1);
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

  it("an authority ban demotes an admin-confirmed anchorage to no_anchoring and an admin-confirmed marina to candidate (ruling, final review 5)", () =>
    withRollback(async (tx) => {
      const ADMIN_AT = new Date("2026-01-01T00:00:00Z");
      for (const [kind, to] of [["anchorage", "no_anchoring"], ["mooring_field", "no_anchoring"], ["marina", "candidate"], ["port", "candidate"]] as const) {
        const place = await placeOf(tx, { kind });
        await setPlaceStatusByAdmin(tx, { placeId: place.placeId, status: "confirmed", from: "candidate", decidedBy: "admin@test.invalid", now: ADMIN_AT });
        const ban = await signalPage(tx, place, { domain: "port-police.example", kind: "prohibited", firstHand: false, pageKind: "authority", observedAt: "2025-06-01" });
        expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config), kind).toEqual([{ placeId: place.placeId, from: "confirmed", to }]);
        expect(await placeRow(tx, place.placeId), kind).toMatchObject({ status: to, statusReason: "Ankerverbot laut Behörde (2025-06-01)" });
        expect((await statusDecisions(tx, place.placeId)).at(-1), kind).toMatchObject({
          decidedBy: "system",
          decision: { action: to === "no_anchoring" ? "no_anchoring" : "candidate", auto: true, rule: "research", overridesAdmin: true, blockingSignalId: ban.signalId },
        });
      }
    }));

  it("other admin-set statuses stay: a forum negative on an admin-confirmed place, a ban on an admin-set candidate (final review 5)", () =>
    withRollback(async (tx) => {
      const ADMIN_AT = new Date("2026-01-01T00:00:00Z");
      const confirmed = await placeOf(tx);
      await setPlaceStatusByAdmin(tx, { placeId: confirmed.placeId, status: "confirmed", from: "candidate", decidedBy: "admin@test.invalid", now: ADMIN_AT });
      await signalPage(tx, confirmed, { domain: "forum.example", kind: "buoys_private", firstHand: false, pageKind: "forum", observedAt: "2026-06-01" });
      expect(await applyBerthVerdicts(tx, [confirmed.placeId], NOW, config)).toEqual([]);
      expect((await placeRow(tx, confirmed.placeId)).status).toBe("confirmed");

      const candidate = await placeOf(tx, { status: "confirmed" });
      await setPlaceStatusByAdmin(tx, { placeId: candidate.placeId, status: "rejected", from: "confirmed", decidedBy: "admin@test.invalid", now: ADMIN_AT });
      await signalPage(tx, candidate, { domain: "port-police.example", kind: "prohibited", firstHand: false, pageKind: "authority" });
      expect(await applyBerthVerdicts(tx, [candidate.placeId], NOW, config)).toEqual([]);
      expect((await placeRow(tx, candidate.placeId)).status).toBe("rejected");
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

  it("two domains quoting the same copied sentence are one source: no confirmation (final review 3)", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      const quote = "The bay offers good holding in sand at 5 to 8 m and shelter from the meltemi.";
      await signalPage(tx, place, { domain: "a.example", quote });
      await signalPage(tx, place, { domain: "b.example", quote });
      expect((await loadEvidence(tx, [place.placeId], config)).get(place.placeId)!.map((e) => e.quote)).toEqual([quote, quote]);
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([]);
      expect(await placeRow(tx, place.placeId)).toMatchObject({ status: "candidate", statusReason: "1 von 2 unabhängigen Quellen (gleicher Text: a.example + b.example)" });
    }));

  it("signals of an ended source give no evidence (Quelle beenden); an old rejected domain still counts", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      const sourceOf = async (versionId: string) =>
        (await tx.execute<{ id: string }>(sql`select d.source_id as id from document_versions v join documents d on d.id = v.document_id where v.id = ${versionId}`)).rows[0]!.id;
      const a = await signalPage(tx, place, { domain: "a.example" });
      const b = await signalPage(tx, place, { domain: "b.example" });
      await signalPage(tx, place, { domain: "c.example" });
      expect((await loadEvidence(tx, [place.placeId], config)).get(place.placeId)).toHaveLength(3);
      await tx.update(sources).set({ status: "rejected" }).where(eq(sources.id, await sourceOf(a.versionId)));
      await tx.update(sources).set({ validTo: "2026-10-01" }).where(eq(sources.id, await sourceOf(b.versionId)));
      expect((await loadEvidence(tx, [place.placeId], config)).get(place.placeId)!.map((e) => e.domain).sort()).toEqual(["a.example", "c.example"]);
      expect(await applyBerthVerdicts(tx, [place.placeId], NOW, config)).toEqual([{ placeId: place.placeId, from: "candidate", to: "confirmed" }]);
    }));

  it("a positive signal counts only from the current version of its page, a negative one from any version (ruling)", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      const pos = await signalPage(tx, place, { domain: "a.example" });
      const neg = await signalPage(tx, place, { domain: "b.example", kind: "closed" });
      const ids = async () => ((await loadEvidence(tx, [place.placeId], config)).get(place.placeId) ?? []).map((e) => e.signalId).sort();
      expect(await ids()).toEqual([pos.signalId, neg.signalId].sort());
      // both pages get a newer version: the old positive no longer stands, the old negative keeps blocking
      for (const v of [pos.versionId, neg.versionId]) {
        const { rows } = await tx.execute<{ id: string }>(sql`select document_id as id from document_versions where id = ${v}`);
        await insertTestVersion(tx, ["newer"], { documentId: rows[0]!.id });
      }
      expect(await ids()).toEqual([neg.signalId]);
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
  it("researchChanges reads the decisions of this run only, a demotion to no_anchoring included (final review 6)", () =>
    withRollback(async (tx) => {
      const confirmed = await placeOf(tx);
      await signalPage(tx, confirmed, { domain: "a.example" });
      await signalPage(tx, confirmed, { domain: "b.example" });
      const banned = await placeOf(tx, { status: "confirmed", publicId: newPublicId("sp") });
      await signalPage(tx, banned, { domain: "port-police.example", kind: "prohibited", firstHand: false, pageKind: "authority" });
      const run = async (placeIds: string[]) =>
        (await createRun(tx, { kind: "reprocess", scope: { type: "system", id: `confirm-${newId()}` }, stages: [RESEARCH_CONFIRM_STAGE], params: { placeIds }, triggeredBy: "test" })).id;

      const first = await run([confirmed.placeId]);
      await confirmBerths(tx, { runId: first, stage: RESEARCH_CONFIRM_STAGE, key: "confirm" }, config, NOW);
      expect((await statusDecisions(tx, confirmed.placeId))[0]!.decision).toMatchObject({ runId: first });
      expect(await researchChanges(tx, first)).toEqual({ changed: [{ placeId: confirmed.placeId, geoObjectId: confirmed.objectId }], confirmed: [confirmed.placeId] });

      // a second run right after: the first run's confirmation is not its change; the ban's demotion is
      const second = await run([confirmed.placeId, banned.placeId]);
      await confirmBerths(tx, { runId: second, stage: RESEARCH_CONFIRM_STAGE, key: "confirm" }, config, NOW);
      expect((await placeRow(tx, banned.placeId)).status).toBe("no_anchoring");
      expect(await researchChanges(tx, second)).toEqual({ changed: [{ placeId: banned.placeId, geoObjectId: banned.objectId }], confirmed: [] });
    }));

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
