import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { berthFacts, berthSignals, documents, pageAssessments, places, researchFetches, researchHits, researchRouteStops, researchUnits, serpQueries, serpResults } from "@/lib/db/schema";
import { activeRouteExtractor } from "@/lib/domain/research/assign";
import { factAttributeLabel, formatFactValue } from "@/lib/domain/facts/labels";
import { activeExtractor } from "@/lib/domain/research/confirmation";
import { getConfig } from "@/lib/config";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { researchView } from "@/lib/domain/research/view";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestRun, insertTestVersion } from "@/test/text";

async function hit(tx: Db, placeId: string, geoObjectId: string, url: string, rank: number, purpose: "positive" | "negative", keyword: string) {
  const [q] = await tx
    .insert(serpQueries)
    .values({ keyword, languageCode: "en", locationCode: 2300, depth: 10, level: "place", scopeId: geoObjectId, rawKey: `serp/x/${url}.json`, fetchedAt: new Date() })
    .returning({ id: serpQueries.id });
  const [r] = await tx
    .insert(serpResults)
    .values({ serpQueryId: q!.id, rank, url, urlNormalized: url, domain: "test.invalid", title: "t", snippet: "s" })
    .returning({ id: serpResults.id });
  await tx.insert(researchHits).values({ placeId, geoObjectId, serpQueryId: q!.id, serpResultId: r!.id, urlNormalized: url, domain: "test.invalid", rank, purpose });
}

/** One page per domain with an active assessment, a search hit, a done unit of the active extractor and an anchored signal. */
async function seedSources(tx: Db, placeId: string, objectId: string, domains: string[]) {
  const { model, promptVersion } = activeAssessor();
  const ex = activeExtractor(getConfig());
  const out: Array<{ versionId: string; unitId: string; url: string }> = [];
  for (const domain of domains) {
    const url = `https://www.${domain}/p`;
    const [doc] = await tx.insert(documents).values({ sourceId: (await insertTestVersion(tx, ["y"])).sourceId, url, urlNormalized: url, docType: "trip_report" }).returning({ id: documents.id });
    const page = await insertTestVersion(tx, ["x"], { documentId: doc!.id });
    await tx.insert(pageAssessments).values({
      documentVersionId: page.versionId, model, promptVersion, pageKind: "trip_report", firstHand: true, generated: false, observedAt: "2025-06-15",
      observedAtBasis: "explicit", berths: [], runId: await insertTestRun(tx),
    });
    await hit(tx, placeId, objectId, url, 1, "positive", "Kolona anchorage");
    const [u] = await tx.insert(researchUnits).values({ documentVersionId: page.versionId, placeId, model: ex.model, promptVersion: ex.promptVersion, status: "done", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 0 } }).returning({ id: researchUnits.id });
    await tx.insert(berthSignals).values({ unitId: u!.id, documentVersionId: page.versionId, placeId, kind: "anchored", firstHand: true, confidence: 0.9, quote: "We anchored", quoteStart: 0, quoteEnd: 5, observedAt: "2025-06-15", observedAtBasis: "explicit" });
    out.push({ versionId: page.versionId, unitId: u!.id, url });
  }
  return out;
}

describe("researchView", () => {
  it("lists assessed and unassessed hits, positive before negative, by rank", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx, { status: "candidate" });
      const assessed = await insertTestVersion(tx, ["x"]);
      const unassessed = await insertTestVersion(tx, ["y"]);
      const urlOf = async (documentId: string) => (await tx.select().from(documents).where(eq(documents.id, documentId)))[0]!.urlNormalized;
      const { model, promptVersion } = activeAssessor();
      const runId = await insertTestRun(tx);
      await tx.insert(pageAssessments).values([
        { documentVersionId: assessed.versionId, model, promptVersion, pageKind: "trip_report", firstHand: true, generated: false, observedAt: "2025-06-15", observedAtBasis: "explicit", berths: [{ name: "Vathi", island: null, kind: "anchorage" }, { name: "Kolona", island: "Kythnos", kind: "anchorage" }], runId },
        // an assessment by another model does not count
        { documentVersionId: unassessed.versionId, model: "old-model", promptVersion: 1, pageKind: "forum", firstHand: false, generated: true, observedAt: "2020-01-01", observedAtBasis: "fetched", berths: [], runId },
      ]);
      await hit(tx, placeId, objectId, await urlOf(unassessed.documentId), 2, "positive", "Kolona anchorage");
      await hit(tx, placeId, objectId, "https://neg.test.invalid/p", 1, "negative", "Kolona anchorage not allowed");
      await hit(tx, placeId, objectId, await urlOf(assessed.documentId), 3, "positive", "Kolona anchorage");

      const { rows } = await researchView(tx, placeId);
      expect(rows.map((r) => [r.purpose, r.rank])).toEqual([["positive", 2], ["positive", 3], ["negative", 1]]);
      expect(rows[0]).toMatchObject({ documentId: unassessed.documentId, assessment: null, keyword: "Kolona anchorage", domain: "test.invalid" });
      expect(rows[1]).toMatchObject({
        documentId: assessed.documentId,
        assessment: { pageKind: "trip_report", firstHand: true, generated: false, observedAt: "2025-06-15", berths: ["Vathi", "Kolona"] },
      });
      expect(rows[2]).toMatchObject({ documentId: null, assessment: null, fetch: null });
    }));

  it("is empty for a place without hits", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      expect((await researchView(tx, placeId)).rows).toEqual([]);
    }));

  it("carries the newest fetch outcome of the page", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx, { status: "candidate" });
      const runId = await insertTestRun(tx);
      const url = "https://fetched.test.invalid/p";
      await hit(tx, placeId, objectId, url, 1, "positive", "Kolona anchorage");
      await tx.insert(researchFetches).values({ urlNormalized: url, runId, outcome: "failed", reason: "HTTP 503", createdAt: new Date("2026-10-01") });
      await tx.insert(researchFetches).values({ urlNormalized: url, runId, outcome: "skipped", reason: "robots", createdAt: new Date("2026-10-02") });
      expect((await researchView(tx, placeId)).rows[0]!.fetch).toEqual({ outcome: "skipped", reason: "robots" });
    }));

  it("carries the verdict, and per page the signals and facts of the active extraction", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx, { status: "candidate" });
      const page = await insertTestVersion(tx, ["x"]);
      const [doc] = await tx.select().from(documents).where(eq(documents.id, page.documentId));
      const { model, promptVersion } = activeAssessor();
      await tx.insert(pageAssessments).values({
        documentVersionId: page.versionId, model, promptVersion, pageKind: "trip_report", firstHand: true, generated: false, observedAt: "2025-06-15",
        observedAtBasis: "explicit", berths: [], runId: await insertTestRun(tx),
      });
      await hit(tx, placeId, objectId, doc!.urlNormalized, 1, "positive", "Kolona anchorage");
      const ex = activeExtractor(getConfig());
      const unit = async (m: string) =>
        (await tx.insert(researchUnits).values({ documentVersionId: page.versionId, placeId, model: m, promptVersion: ex.promptVersion, status: "done", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 0 } }).returning({ id: researchUnits.id }))[0]!.id;
      const active = await unit(ex.model);
      const stale = await unit("old-model");
      const at = { documentVersionId: page.versionId, placeId, quoteStart: 0, quoteEnd: 5, observedAt: "2025-06-15", observedAtBasis: "explicit" as const };
      await tx.insert(berthSignals).values([
        { ...at, unitId: active, kind: "anchored", firstHand: true, confidence: 0.9, quote: "We anchored here" },
        { ...at, unitId: stale, kind: "berthed", firstHand: true, confidence: 0.9, quote: "stale answer" },
      ]);
      await tx.insert(berthFacts).values([
        { ...at, unitId: active, statement: "Good holding on sand", quote: "good holding", tone: "positive" },
        { ...at, unitId: active, attribute: "holding", value: "sand", subjectName: "Taverna Nikos", quote: "sand" },
      ]);

      const view = await researchView(tx, placeId);
      expect(view.verdict.status).toBe("candidate");
      expect(view.verdict.reason).toMatch(/unabhängigen Quellen/);
      const [row] = view.rows;
      expect(row).toMatchObject({ signalCount: 1, factCount: 2 });
      expect(row!.signals).toEqual([{ kind: "anchored", firstHand: true, confidence: 0.9, observedAt: "2025-06-15", observedAtBasis: "explicit", quote: "We anchored here" }]);
      expect(row!.facts.map((f) => [f.statement, f.subject, f.tone])).toEqual(expect.arrayContaining([["Good holding on sand", null, "positive"]]));
      expect(row!.facts.find((f) => f.subject === "Taverna Nikos")).toBeDefined();
    }));

  it("says confirmed with the sources of two independent domains", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx, { status: "candidate" });
      const { model, promptVersion } = activeAssessor();
      const ex = activeExtractor(getConfig());
      for (const domain of ["sail-a.example", "sail-b.example"]) {
        const url = `https://www.${domain}/p`;
        const [sourceDoc] = await tx.insert(documents).values({ sourceId: (await insertTestVersion(tx, ["y"])).sourceId, url, urlNormalized: url, docType: "trip_report" }).returning({ id: documents.id });
        const page = await insertTestVersion(tx, ["x"], { documentId: sourceDoc!.id });
        await tx.insert(pageAssessments).values({
          documentVersionId: page.versionId, model, promptVersion, pageKind: "trip_report", firstHand: true, generated: false, observedAt: "2025-06-15",
          observedAtBasis: "explicit", berths: [], runId: await insertTestRun(tx),
        });
        await hit(tx, placeId, objectId, url, 1, "positive", "Kolona anchorage");
        const [u] = await tx.insert(researchUnits).values({ documentVersionId: page.versionId, placeId, model: ex.model, promptVersion: ex.promptVersion, status: "done", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 0 } }).returning({ id: researchUnits.id });
        await tx.insert(berthSignals).values({ unitId: u!.id, documentVersionId: page.versionId, placeId, kind: "anchored", firstHand: true, confidence: 0.9, quote: "We anchored", quoteStart: 0, quoteEnd: 5, observedAt: "2025-06-15", observedAtBasis: "explicit" });
      }
      const { verdict } = await researchView(tx, placeId);
      expect(verdict).toMatchObject({ status: "confirmed", independentSources: ["sail-a.example", "sail-b.example"] });
    }));

  it("carries the place's actual status and reason beside the rule's verdict", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx, { status: "confirmed" });
      // an admin-confirmed place without any evidence: the rule says candidate, the status stays confirmed
      const view = await researchView(tx, placeId);
      expect(view).toMatchObject({ status: "confirmed", statusReason: null });
      expect(view.verdict.status).toBe("candidate");
    }));

  it("shows a place the rule would confirm as no_anchoring with its own status and reason", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx, { status: "candidate" });
      await seedSources(tx, placeId, objectId, ["sail-a.example", "sail-b.example"]);
      await tx.update(places).set({ status: "no_anchoring", statusReason: "Sperrgebiet" }).where(eq(places.id, placeId));
      const view = await researchView(tx, placeId);
      expect(view).toMatchObject({ status: "no_anchoring", statusReason: "Sperrgebiet" });
      expect(view.verdict.status).toBe("confirmed");
    }));

  it("shows a URL that is a positive and a negative hit once, with both purposes", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx, { status: "candidate" });
      await hit(tx, placeId, objectId, "https://both.test.invalid/p", 2, "positive", "Kolona anchorage");
      await hit(tx, placeId, objectId, "https://both.test.invalid/p", 1, "negative", "Kolona anchorage not allowed");
      const { rows } = await researchView(tx, placeId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ purpose: "positive", purposes: ["positive", "negative"] });
    }));

  it("gives a structured fact a German statement, not raw JSON", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx, { status: "candidate" });
      const [{ versionId, unitId, url }] = await seedSources(tx, placeId, objectId, ["sail-a.example"]);
      await tx.insert(berthFacts).values({
        unitId, placeId, documentVersionId: versionId, attribute: "holding", value: "good", quote: "good holding", quoteStart: 0, quoteEnd: 5, observedAt: "2025-06-15", observedAtBasis: "explicit",
      });
      const { rows } = await researchView(tx, placeId);
      const fact = rows.find((r) => r.url === url)!.facts[0]!;
      expect(fact.statement).toBe(`${factAttributeLabel("holding")}: ${formatFactValue("holding", "good")}`);
      expect(fact.statement).not.toContain("\"");
    }));

  it("shows every page behind the verdict: pages linked by a neighbour's hit (unit) and by a route stop (final review 7)", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx, { status: "candidate" });
      const ex = activeExtractor(getConfig());
      const route = activeRouteExtractor(getConfig());
      const { model, promptVersion } = activeAssessor();
      // a page that is a hit of the place, a page that is only a neighbour's hit (unit of this place), a page linked by a route stop
      const [own] = await seedSources(tx, placeId, objectId, ["own.example"]);
      const linked = async (domain: string) => {
        const url = `https://www.${domain}/p`;
        const [doc] = await tx.insert(documents).values({ sourceId: (await insertTestVersion(tx, ["y"])).sourceId, url, urlNormalized: url, docType: "trip_report" }).returning({ id: documents.id });
        const page = await insertTestVersion(tx, ["x"], { documentId: doc!.id });
        await tx.insert(pageAssessments).values({
          documentVersionId: page.versionId, model, promptVersion, pageKind: "trip_report", firstHand: true, generated: false, observedAt: "2025-06-15",
          observedAtBasis: "explicit", berths: [{ name: "Kolona", island: null, kind: "anchorage" }], runId: await insertTestRun(tx),
        });
        const [u] = await tx.insert(researchUnits).values({ documentVersionId: page.versionId, placeId, model: ex.model, promptVersion: ex.promptVersion, status: "done", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 0 } }).returning({ id: researchUnits.id });
        await tx.insert(berthSignals).values({ unitId: u!.id, documentVersionId: page.versionId, placeId, kind: "anchored", firstHand: true, confidence: 0.9, quote: `We anchored (${domain})`, quoteStart: 0, quoteEnd: 5, observedAt: "2025-06-15", observedAtBasis: "explicit" });
        return { url, documentId: doc!.id, versionId: page.versionId };
      };
      const neighbour = await linked("neighbour.example");
      const routed = await linked("route.example");
      await tx.insert(researchRouteStops).values({ documentVersionId: routed.versionId, seq: 1, name: "Kolona", quote: "q", observedAt: "2025-06-15", placeId, match: "name", model: route.model, promptVersion: route.promptVersion });

      const view = await researchView(tx, placeId);
      expect(view.verdict).toMatchObject({ status: "confirmed" });
      expect(view.rows.map((r) => [r.url, r.link])).toEqual([
        [own!.url, "search"],
        [neighbour.url, "neighbour"],
        [routed.url, "route"],
      ]);
      const n = view.rows.find((r) => r.link === "neighbour")!;
      expect(n).toMatchObject({ documentId: neighbour.documentId, rank: null, keyword: null, purpose: null, purposes: [], signalCount: 1, domain: "neighbour.example" });
      expect(n.assessment).toMatchObject({ pageKind: "trip_report", berths: ["Kolona"] });
      expect(view.rows.find((r) => r.link === "route")!.signals.map((s) => s.quote)).toEqual(["We anchored (route.example)"]);
    }));
});
