import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { crawlFrontier, documents, documentVersions, sources } from "@/lib/db/schema";
import { recordExternalCall } from "@/lib/domain/costs";
import { newId } from "@/lib/domain/ids";
import { createReviewTask } from "@/lib/domain/review";
import { withRollback } from "@/test/db";
import { assessSources, checkFailures, checkSources } from "../check-sources";

describe("check-sources", () => {
  it("reports 19 approved sources as out of range and a provisional decision", () => {
    const cfg = getConfig();
    expect(cfg.fetch.decision.status).toBe("provisional");
    const result = assessSources({ approved: 19, perSource: [], openFailedFetchJobs: 0 }, cfg);
    expect(result).toEqual({
      approved: 19,
      inRange: false,
      perSource: [],
      withoutDocuments: [],
      openFailedFetchJobs: 0,
      converterDecision: "provisional",
      pdfExtractor: "pdftotext",
    });
    expect(checkFailures(result)).toEqual([
      "approved sources 19 outside 20–40",
      "converter decision is provisional (config/fetch.json decision.status)",
    ]);
  });

  it("20 and 40 approved sources with a decided converter and no failed jobs pass", () => {
    const base = getConfig();
    const cfg = { ...base, fetch: { ...base.fetch, decision: { status: "decided" as const, note: "Lokal." } } };
    for (const approved of [20, 40]) {
      const result = assessSources({ approved, perSource: [], openFailedFetchJobs: 0 }, cfg);
      expect(result).toMatchObject({ inRange: true, converterDecision: "decided" });
      expect(checkFailures(result)).toEqual([]);
    }
    expect(checkFailures(assessSources({ approved: 41, perSource: [], openFailedFetchJobs: 2 }, cfg))).toEqual([
      "approved sources 41 outside 20–40",
      "2 open failed fetch/embed jobs in /review",
    ]);

    // An approved source the crawl never archived fails the check.
    const perSource = [
      { domain: "crawled.example", documents: 3, versions: 3, queued: 0, failed: 0, costEur: 0 },
      { domain: "never.example", documents: 0, versions: 0, queued: 1, failed: 0, costEur: 0 },
    ];
    const uncrawled = assessSources({ approved: 20, perSource, openFailedFetchJobs: 0 }, cfg);
    expect(uncrawled.withoutDocuments).toEqual(["never.example"]);
    expect(checkFailures(uncrawled)).toEqual(["approved sources without documents (not crawled yet?): never.example"]);
  });

  it("counts documents, versions, frontier rows, costs per approved source and open failed fetch jobs", () =>
    withRollback(
      async (tx) => {
        const before = await checkSources(tx);
        const domain = `${newId()}.test.invalid`;
        const [source] = await tx
          .insert(sources)
          .values({ domain, name: domain, type: "forum", weight: 0.4, status: "approved", crawlRules: {}, origin: "manual" })
          .returning({ id: sources.id });
        const url = `https://${domain}/a`;
        const [doc] = await tx.insert(documents).values({ sourceId: source!.id, url, urlNormalized: url, docType: "forum" }).returning({ id: documents.id });
        for (const hash of ["h1", "h2"]) {
          await tx.insert(documentVersions).values({
            documentId: doc!.id,
            fetchedAt: new Date(),
            contentHash: hash,
            rawHash: hash,
            rawKey: `archive/${doc!.id}/${hash}.raw.html`,
            mdKey: `archive/${doc!.id}/${hash}.md`,
            observedAt: "2026-10-19",
            observedAtBasis: "fetched",
            docType: "forum",
            converter: "local",
            charCount: 10,
          });
        }
        await tx.insert(crawlFrontier).values([
          { sourceId: source!.id, url, urlNormalized: url, status: "fetched" },
          { sourceId: source!.id, url: `${url}/q`, urlNormalized: `${url}/q`, status: "queued" },
          { sourceId: source!.id, url: `${url}/f`, urlNormalized: `${url}/f`, status: "failed" },
        ]);
        await recordExternalCall(tx, { service: "jina", operation: "read", units: 1, unit: "tokens", costEur: 0.25, sourceId: source!.id });
        await recordExternalCall(tx, { service: "crawl", operation: "page", units: 1, unit: "request", costEur: 0, sourceId: source!.id });
        await createReviewTask(tx, { kind: "failed_job", subjectType: "job", subjectId: newId(), context: { queue: "fetch.url" } });
        await createReviewTask(tx, { kind: "failed_job", subjectType: "job", subjectId: newId(), context: { queue: "embed.chunks" } });
        await createReviewTask(tx, { kind: "failed_job", subjectType: "job", subjectId: newId(), context: { queue: "geometry.compute" } });

        const after = await checkSources(tx);
        expect(after.approved - before.approved).toBe(1);
        expect(after.openFailedFetchJobs - before.openFailedFetchJobs).toBe(2);
        expect(after.perSource.find((s) => s.domain === domain)).toEqual({ domain, documents: 1, versions: 2, queued: 1, failed: 1, costEur: 0.25 });
      },
      { isolationLevel: "repeatable read" },
    ));
});
