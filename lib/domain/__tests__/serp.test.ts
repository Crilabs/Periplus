import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeResponse, type Transport } from "@/lib/adapters/http";
import { externalCalls, serpQueries, serpResults } from "@/lib/db/schema";
import type { DiscoveryQuery } from "@/lib/domain/search/queries";
import { runQuery } from "@/lib/domain/discovery/serp";
import { newId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

const NOW = new Date("2026-10-19T09:30:00Z");
const DAY_MS = 86_400_000;

const refuse: Transport = async () => {
  throw new Error("transport must not be called");
};

const answer = (): Transport => {
  const body = readFileSync("test/fixtures/http/dataforseo/hand/organic-20-paa.json");
  return async () => makeResponse(200, new Uint8Array(body));
};

/** A query no other test (or earlier run) has made: reuse is looked up database-wide. */
function uniqueQuery(level: DiscoveryQuery["level"] = "tile"): DiscoveryQuery {
  return {
    keyword: `anchorage test-${newId()}`,
    languageCode: "en",
    locationCode: 2826,
    level,
    scopeId: level === "tile" ? `test:${newId()}` : "saronic",
    priority: 1,
  };
}

describe("runQuery", () => {
  it("the same query within 30 days is reused without a call", async () => {
    await withRollback(async (tx) => {
      const q = uniqueQuery();
      const [prior] = await tx
        .insert(serpQueries)
        .values({
          keyword: q.keyword,
          languageCode: q.languageCode,
          locationCode: q.locationCode,
          depth: 20,
          level: "area",
          scopeId: "saronic",
          rawKey: "serp/2026-09-30/x.json",
          fetchedAt: new Date(NOW.getTime() - 29 * DAY_MS),
        })
        .returning({ id: serpQueries.id });
      await tx.insert(serpResults).values(
        [1, 2].map((rank) => ({
          serpQueryId: prior!.id,
          rank,
          url: `https://a${rank}.example/`,
          urlNormalized: `https://a${rank}.example/`,
          domain: `a${rank}.example`,
          title: "t",
          snippet: "s",
        })),
      );

      const result = await runQuery(tx, q, { transport: refuse, archive: memoryArchive(), now: NOW }, { db: tx });
      expect(result).toEqual({ queryId: prior!.id, reused: true, results: 2 });
    });
  });

  it("a query older than 30 days is searched again", async () => {
    await withRollback(async (tx) => {
      const q = uniqueQuery();
      await tx.insert(serpQueries).values({
        keyword: q.keyword,
        languageCode: q.languageCode,
        locationCode: q.locationCode,
        depth: 20,
        level: "tile",
        scopeId: q.scopeId,
        rawKey: "serp/2026-09-01/x.json",
        fetchedAt: new Date(NOW.getTime() - 31 * DAY_MS),
      });
      const result = await runQuery(tx, q, { transport: answer(), archive: memoryArchive(), now: NOW }, { db: tx });
      expect(result.reused).toBe(false);
      expect(result.results).toBe(20);
    });
  });

  it("the raw answer is archived under serp/<day>/<hash>.json", async () => {
    await withRollback(async (tx) => {
      const q = uniqueQuery();
      const archive = memoryArchive();
      const result = await runQuery(tx, q, { transport: answer(), archive, now: NOW }, { db: tx, stage: "discovery.tile" });

      const hash = createHash("sha256").update(`${q.keyword}|en|2826`).digest("hex");
      const key = `serp/2026-10-19/${hash}.json`;
      expect(archive.keys()).toEqual([key]);
      expect(new TextDecoder().decode((await archive.get(key))!)).toBe(
        readFileSync("test/fixtures/http/dataforseo/hand/organic-20-paa.json", "utf8"),
      );

      const [row] = await tx.select().from(serpQueries).where(eq(serpQueries.id, result.queryId));
      expect(row).toMatchObject({
        keyword: q.keyword,
        languageCode: "en",
        locationCode: 2826,
        depth: 20,
        level: "tile",
        scopeId: q.scopeId,
        rawKey: key,
        fetchedAt: NOW,
      });
      const results = await tx
        .select()
        .from(serpResults)
        .where(eq(serpResults.serpQueryId, result.queryId))
        .orderBy(asc(serpResults.rank));
      expect(result).toEqual({ queryId: result.queryId, reused: false, results: 20 });
      expect(results).toHaveLength(20);
      expect(results[0]).toMatchObject({
        rank: 1,
        url: "https://www.site1.example/page-1?utm_source=x",
        urlNormalized: "https://www.site1.example/page-1",
        domain: "site1.example",
        title: "Result 1",
        snippet: "Snippet 1",
      });

      // A tile query's cost is booked on its tile.
      const calls = await tx.select().from(externalCalls).where(eq(externalCalls.tileId, q.scopeId));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ service: "dataforseo", stage: "discovery.tile" });
    });
  });

  it("an area query keeps the caller's context", async () => {
    await withRollback(async (tx) => {
      const q = uniqueQuery("area");
      const tileId = `test:${newId()}`;
      await runQuery(tx, q, { transport: answer(), archive: memoryArchive(), now: NOW }, { db: tx, tileId });
      const calls = await tx.select().from(externalCalls).where(eq(externalCalls.tileId, tileId));
      expect(calls).toHaveLength(1);
    });
  });
});
