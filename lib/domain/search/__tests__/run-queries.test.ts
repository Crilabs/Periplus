import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { getConfig } from "@/lib/config";
import { serpQueries } from "@/lib/db/schema";
import type { DiscoveryQuery } from "@/lib/domain/search/queries";
import { newId } from "@/lib/domain/ids";
import { runQueries } from "@/lib/domain/search/run-queries";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

const HAND = "test/fixtures/http/dataforseo/hand";

const query = (keyword: string): DiscoveryQuery => ({
  keyword,
  languageCode: "en",
  locationCode: 2826,
  level: "tile",
  scopeId: `test:${newId()}`,
  priority: 1,
});

/** Answers the keyword `failing` always with a 40101 task error, every other keyword with organic results. */
function transportFailing(failing: string): Transport {
  const error = readFileSync(`${HAND}/task-40101.json`);
  const ok = readFileSync(`${HAND}/organic-20-paa.json`);
  return async (req: HttpRequest) => {
    const [task] = JSON.parse(String(req.body)) as Array<{ keyword: string }>;
    return makeResponse(200, new Uint8Array(task!.keyword === failing ? error : ok));
  };
}

describe("runQueries", () => {
  it("a query that keeps failing with 40101 is skipped and counted; the other queries still run", async () => {
    const serp = getConfig().discovery.serp;
    const delay = serp.taskRetryDelayMs;
    serp.taskRetryDelayMs = 0;
    try {
      await withRollback(async (tx) => {
        const bad = query(`anchorage failing ${newId()}`);
        const good = [query(`anchorage a ${newId()}`), query(`anchorage b ${newId()}`)];
        const summary = await runQueries(tx, [good[0]!, bad, good[1]!], { transport: transportFailing(bad.keyword), archive: memoryArchive() }, { db: tx });
        expect(summary).toMatchObject({ queries: 3, searched: 2, reused: 0, failed: 1 });
        const stored = await tx
          .select({ keyword: serpQueries.keyword })
          .from(serpQueries)
          .where(inArray(serpQueries.keyword, [bad.keyword, ...good.map((g) => g.keyword)]));
        expect(stored.map((s) => s.keyword).sort()).toEqual(good.map((g) => g.keyword).sort());
      });
    } finally {
      serp.taskRetryDelayMs = delay;
    }
  });

  it("when every searched query fails, the job fails so it is retried later", async () => {
    const serp = getConfig().discovery.serp;
    const delay = serp.taskRetryDelayMs;
    serp.taskRetryDelayMs = 0;
    try {
      await withRollback(async (tx) => {
        const bad = query(`anchorage failing ${newId()}`);
        await expect(runQueries(tx, [bad], { transport: transportFailing(bad.keyword), archive: memoryArchive() }, { db: tx })).rejects.toThrow(/40101/);
      });
    } finally {
      serp.taskRetryDelayMs = delay;
    }
  });
});
