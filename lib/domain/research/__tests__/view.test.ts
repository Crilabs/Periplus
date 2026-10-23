import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { documents, pageAssessments, researchFetches, researchHits, serpQueries, serpResults } from "@/lib/db/schema";
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

      const rows = await researchView(tx, placeId);
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
      expect(await researchView(tx, placeId)).toEqual([]);
    }));

  it("carries the newest fetch outcome of the page", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx, { status: "candidate" });
      const runId = await insertTestRun(tx);
      const url = "https://fetched.test.invalid/p";
      await hit(tx, placeId, objectId, url, 1, "positive", "Kolona anchorage");
      await tx.insert(researchFetches).values({ urlNormalized: url, runId, outcome: "failed", reason: "HTTP 503", createdAt: new Date("2026-10-01") });
      await tx.insert(researchFetches).values({ urlNormalized: url, runId, outcome: "skipped", reason: "robots", createdAt: new Date("2026-10-02") });
      expect((await researchView(tx, placeId))[0]!.fetch).toEqual({ outcome: "skipped", reason: "robots" });
    }));
});
