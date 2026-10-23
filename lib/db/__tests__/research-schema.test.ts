import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { pageAssessments, researchHits, serpQueries, serpResults } from "@/lib/db/schema";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestRun, insertTestVersion } from "@/test/text";

/** drizzle wraps driver errors ("Failed query"); the Postgres message lives on `cause`. */
async function rejectionMessage(tx: Db, run: (tx: Db) => Promise<unknown>): Promise<string> {
  try {
    await tx.transaction(async (sp) => {
      await run(sp);
    });
  } catch (e) {
    const err = e as Error;
    return `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`;
  }
  throw new Error("expected promise to reject");
}

describe("research schema", () => {
  it("allows one hit per place, url and purpose", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx);
      const runId = await insertTestRun(tx);
      const [q] = await tx
        .insert(serpQueries)
        .values({ keyword: "kolona anchorage", languageCode: "en", locationCode: 2826, depth: 10, level: "research", scopeId: "t", rawKey: "serp/x.json", fetchedAt: new Date() })
        .returning({ id: serpQueries.id });
      const [r] = await tx
        .insert(serpResults)
        .values({ serpQueryId: q!.id, rank: 1, url: "https://a.test/p", urlNormalized: "a.test/p", domain: "a.test", title: "t", snippet: "s" })
        .returning({ id: serpResults.id });
      const hit = (purpose: "positive" | "negative" | "landside") => ({
        placeId,
        geoObjectId: objectId,
        serpQueryId: q!.id,
        serpResultId: r!.id,
        urlNormalized: "a.test/p",
        domain: "a.test",
        rank: 1,
        purpose,
        runId,
      });
      await tx.insert(researchHits).values(hit("positive"));
      expect(await rejectionMessage(tx, (t) => t.insert(researchHits).values(hit("positive")))).toContain("research_hits_place_id_url_normalized_purpose_unique");
      await tx.insert(researchHits).values(hit("negative"));
      await tx.insert(researchHits).values(hit("landside"));
    }));

  it("allows one assessment per version, model and prompt version", () =>
    withRollback(async (tx) => {
      const { versionId } = await insertTestVersion(tx, ["text"]);
      const values = (promptVersion: number) => ({
        documentVersionId: versionId,
        model: "m",
        promptVersion,
        pageKind: "trip_report" as const,
        firstHand: true,
        generated: false,
        observedAt: "2026-10-19",
        observedAtBasis: "fetched" as const,
        berths: [{ name: "Kolona", island: "Kythnos", kind: "anchorage" as const }],
      });
      await tx.insert(pageAssessments).values(values(1));
      expect(await rejectionMessage(tx, (t) => t.insert(pageAssessments).values(values(1)))).toContain("page_assessments_version_model_prompt_unique");
      await tx.insert(pageAssessments).values(values(2));
    }));
});
