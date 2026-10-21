import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { searchOrganic } from "@/lib/adapters/dataforseo";
import { HttpError, makeResponse, RetryableHttpError, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import { getConfig } from "@/lib/config";
import { externalCalls } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";

const HAND = "test/fixtures/http/dataforseo/hand";

const cfg = () => ({ ...getConfig().discovery.serp, ratePerMinute: 1_000_000, taskRetryDelayMs: 0 });

/** Answers every request with the hand-written body `<HAND>/<name>.json` and keeps the requests. */
function handTransport(name: string): Transport & { requests: HttpRequest[] } {
  const body = readFileSync(`${HAND}/${name}.json`);
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest) => {
    requests.push(req);
    return makeResponse(200, new Uint8Array(body), { headers: { "content-type": "application/json" } });
  };
  return Object.assign(transport, { requests });
}

const query = { keyword: "anchorage hand", languageCode: "en", locationCode: 2826 };

describe("searchOrganic", () => {
  it("parses only organic items with absolute ranks", async () => {
    await withRollback(async (tx) => {
      const tileId = `test:${newId()}`;
      const transport = handTransport("organic-20-paa");
      const { raw, items } = await searchOrganic(transport, query, { db: tx, tileId, stage: "discovery.tile" }, cfg());

      expect(items).toHaveLength(20);
      expect(items.map((i) => i.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(items[0]).toEqual({
        rank: 1,
        url: "https://www.site1.example/page-1?utm_source=x",
        title: "Result 1",
        snippet: "Snippet 1",
      });
      expect(new TextDecoder().decode(raw)).toBe(readFileSync(`${HAND}/organic-20-paa.json`, "utf8"));

      const [req] = transport.requests;
      expect(req!.method).toBe("POST");
      expect(req!.url).toBe(getConfig().discovery.serp.endpoint);
      expect(JSON.parse(String(req!.body))).toEqual([{ keyword: "anchorage hand", language_code: "en", location_code: 2826, depth: 20 }]);
      const auth = Buffer.from("test@example.invalid:test-password").toString("base64");
      expect(req!.headers?.Authorization).toBe(`Basic ${auth}`);
      expect(req!.budget).toBe("dataforseo");

      const calls = await tx.select().from(externalCalls).where(eq(externalCalls.tileId, tileId));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ service: "dataforseo", unit: "query", stage: "discovery.tile" });
      expect(Number(calls[0]!.units)).toBe(1);
      expect(Number(calls[0]!.costEur)).toBeCloseTo(getConfig().discovery.serp.costPerQueryEur, 6);
    });
  });

  it("a 40501 task status is not retried", async () => {
    await withRollback(async (tx) => {
      const tileId = `test:${newId()}`;
      const error = await searchOrganic(handTransport("task-40501"), query, { db: tx, tileId }, cfg()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect(error).not.toBeInstanceOf(RetryableHttpError);
      expect((error as Error).message).toMatch(/40501/);
      // DataForSEO bills an errored task too.
      const [call] = await tx.select().from(externalCalls).where(eq(externalCalls.tileId, tileId));
      expect(Number(call!.costEur)).toBeCloseTo(getConfig().discovery.serp.costPerQueryEur, 6);
    });
  });

  it("a 40101 task status is retried within the call and the next answer is used", async () => {
    await withRollback(async (tx) => {
      const bodies = ["task-40101", "organic-20-paa"].map((n) => readFileSync(`${HAND}/${n}.json`));
      let calls = 0;
      const transport: Transport = async () => makeResponse(200, new Uint8Array(bodies[Math.min(calls++, 1)]!));
      const { items } = await searchOrganic(transport, query, { db: tx }, cfg());
      expect(calls).toBe(2);
      expect(items.length).toBeGreaterThan(0);
    });
  });

  it("a 40101 task status that persists gives up after taskRetries further attempts", async () => {
    await withRollback(async (tx) => {
      const transport = handTransport("task-40101");
      const error = await searchOrganic(transport, query, { db: tx }, cfg()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RetryableHttpError);
      expect(transport.requests).toHaveLength(1 + getConfig().discovery.serp.taskRetries);
    });
  });

  it("a 50000 task status is retryable", async () => {
    await withRollback(async (tx) => {
      const error = await searchOrganic(handTransport("task-50000"), query, { db: tx }, cfg()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RetryableHttpError);
      expect((error as Error).message).toMatch(/50000/);
    });
  });

  it("an unreadable answer is retryable", async () => {
    await withRollback(async (tx) => {
      const garbage: Transport = async () => makeResponse(200, new TextEncoder().encode("<html>busy</html>"));
      await expect(searchOrganic(garbage, query, { db: tx }, cfg())).rejects.toBeInstanceOf(RetryableHttpError);
    });
  });

  it("replays a recorded live answer", async () => {
    await withRollback(async (tx) => {
      const { items } = await searchOrganic(
        fixtureTransport(),
        { keyword: "Törnbericht Saronischer Golf", languageCode: "de", locationCode: 2276 },
        { db: tx },
        cfg(),
      );
      // Live answers count every SERP element in rank_absolute: organic ranks have gaps.
      expect(items).toHaveLength(19);
      expect(items[0]!.rank).toBe(1);
      expect(items.at(-1)!.rank).toBe(21);
      for (const item of items) {
        expect(item.url).toMatch(/^https?:\/\//);
        expect(item.title).not.toBe("");
      }
      const ranks = items.map((i) => i.rank);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    });
  });

  it("a recorded live 40101 task error is retried", async () => {
    await withRollback(async (tx) => {
      const error = await searchOrganic(
        fixtureTransport(),
        { keyword: "Saronic Gulf anchorages", languageCode: "en", locationCode: 2826 },
        { db: tx },
        cfg(),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RetryableHttpError);
      expect((error as Error).message).toMatch(/40101/);
    });
  });
});
