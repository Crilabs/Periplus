import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeResponse, RetryableHttpError, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import { embedTexts } from "@/lib/adapters/voyage";
import { getConfig } from "@/lib/config";
import { externalCalls } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";
import { VOYAGE_RECORDING_TEXTS } from "@/scripts/fixtures-record";

const cfg = () => ({ ...getConfig().embeddings, ratePerMinute: 1_000_000 });

/** Answers with `body` and keeps the requests. */
function stub(body: unknown): Transport & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest) => {
    requests.push(req);
    return makeResponse(200, new TextEncoder().encode(JSON.stringify(body)), { headers: { "content-type": "application/json" } });
  };
  return Object.assign(transport, { requests });
}

const vector = (n: number, v = 0.1) => Array.from({ length: n }, () => v);

describe("embedTexts", () => {
  it("returns 1024-dimensional vectors in input order and records the token cost", async () => {
    await withRollback(async (tx) => {
      const sourceId = newId();
      const stage = `embed-test-${newId()}`;
      const texts = [...VOYAGE_RECORDING_TEXTS];
      const { vectors, tokens } = await embedTexts(fixtureTransport(), texts, { db: tx, stage, sourceId }, cfg());

      expect(vectors).toHaveLength(2);
      for (const v of vectors) expect(v).toHaveLength(1024);
      expect(vectors[0]).not.toEqual(vectors[1]);
      expect(tokens).toBeGreaterThan(0);

      const calls = await tx
        .select()
        .from(externalCalls)
        .where(and(eq(externalCalls.service, "voyage"), eq(externalCalls.stage, stage)));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ operation: "embed", unit: "tokens", units: String(tokens), sourceId });
      expect(Number(calls[0]!.costEur)).toBeCloseTo((tokens * getConfig().embeddings.eurPerMTok) / 1e6, 6);
    });
  });

  it("a 429 from Voyage is retryable and costs nothing", async () => {
    await withRollback(async (tx) => {
      const stage = `embed-test-${newId()}`;
      const limited: Transport = async () =>
        makeResponse(429, new TextEncoder().encode('{"detail":"rate limit"}'), { headers: { "content-type": "application/json" } });
      await expect(embedTexts(limited, ["a"], { db: tx, stage }, cfg())).rejects.toBeInstanceOf(RetryableHttpError);
      const calls = await tx.select().from(externalCalls).where(and(eq(externalCalls.service, "voyage"), eq(externalCalls.stage, stage)));
      expect(calls.map((c) => Number(c.costEur))).toEqual([0]);
    });
  });

  it("sorts the vectors by the answer's index and sends model, dimension and input type", async () => {
    await withRollback(async (tx) => {
      const transport = stub({
        data: [
          { embedding: vector(1024, 0.2), index: 1 },
          { embedding: vector(1024, 0.1), index: 0 },
        ],
        usage: { total_tokens: 12 },
      });
      const { vectors, tokens } = await embedTexts(transport, ["a", "b"], { db: tx, stage: "embed-test" }, cfg());
      expect(vectors.map((v) => v[0])).toEqual([0.1, 0.2]);
      expect(tokens).toBe(12);
      const req = transport.requests[0]!;
      expect(req.method).toBe("POST");
      expect(req.url).toBe(getConfig().embeddings.endpoint);
      expect(req.headers?.Authorization).toBe("Bearer test-voyage-key");
      expect(JSON.parse(String(req.body))).toEqual({ input: ["a", "b"], model: "voyage-3.5", input_type: "document", output_dimension: 1024 });
    });
  });

  it("a vector of another length is an error", async () => {
    await withRollback(async (tx) => {
      const transport = stub({ data: [{ embedding: vector(512), index: 0 }], usage: { total_tokens: 3 } });
      await expect(embedTexts(transport, ["a"], { db: tx, stage: "embed-test" }, cfg())).rejects.toThrow(
        /512 dimensions, expected 1024/,
      );
    });
  });

  it("an answer without a vector for every text is an error", async () => {
    await withRollback(async (tx) => {
      const transport = stub({ data: [{ embedding: vector(1024), index: 0 }], usage: { total_tokens: 3 } });
      await expect(embedTexts(transport, ["a", "b"], { db: tx, stage: "embed-test" }, cfg())).rejects.toThrow(/no embedding for text 1/);
    });
  });
});
