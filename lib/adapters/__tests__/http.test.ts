import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { externalCalls } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import {
  HttpError,
  RetryableHttpError,
  fetchTransport,
  getTransport,
  httpCall,
  makeResponse,
  setTransport,
  type HttpRequest,
  type Transport,
} from "@/lib/adapters/http";
import { fixtureKey, fixtureTransport, recordingTransport } from "@/lib/adapters/http-fixtures";

const db = testDb();

const uniqueService = () => `test-${newId()}`;

/** In-memory transport that answers every request with `status` and remembers what it was called with. */
function stubTransport(status: number, body = "ok"): Transport & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const t = (async (req: HttpRequest) => {
    calls.push(req);
    return makeResponse(status, new TextEncoder().encode(body));
  }) as Transport & { calls: HttpRequest[] };
  t.calls = calls;
  return t;
}

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "periplus-http-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("httpCall", () => {
  it("rethrows the original transport error when recording the failed call fails too", async () => {
    const boom = new RetryableHttpError("network down");
    const failingDb = {
      insert: () => {
        throw new Error("db down");
      },
    } as unknown as typeof db;
    const transport: Transport = async () => {
      throw boom;
    };
    await expect(
      httpCall(transport, { service: uniqueService(), operation: "probe", url: "https://example.invalid/x", timeoutMs: 1000 }, { db: failingDb }),
    ).rejects.toBe(boom);
  });

  it("sets the contact user agent and records an external call with cost 0", async () => {
    const service = uniqueService();
    const transport = stubTransport(200, "hello");
    const res = await httpCall(
      transport,
      { service, operation: "probe", url: "https://example.invalid/a", timeoutMs: 1000 },
      { db, tileId: "q025:800:508", stage: "gazetteer" },
    );
    expect(res.status).toBe(200);
    expect(res.text()).toBe("hello");
    expect(transport.calls[0]?.headers?.["User-Agent"]).toBe("Periplus/0.1 (+mailto:test@example.invalid)");

    const rows = await db.select().from(externalCalls).where(eq(externalCalls.service, service));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: "probe",
      unit: "request",
      tileId: "q025:800:508",
      stage: "gazetteer",
      meta: { status: 200, bytes: 5 },
    });
    expect(Number(rows[0]!.costEur)).toBe(0);
    expect(Number(rows[0]!.units)).toBe(1);
  });

  it("429 and 503 throw RetryableHttpError, 404 throws HttpError", async () => {
    const call = (status: number) =>
      httpCall(
        stubTransport(status),
        { service: uniqueService(), operation: "probe", url: "https://example.invalid/s", timeoutMs: 1000 },
        { db },
      );
    await expect(call(429)).rejects.toBeInstanceOf(RetryableHttpError);
    await expect(call(503)).rejects.toBeInstanceOf(RetryableHttpError);
    const notFound = await call(404).catch((e: unknown) => e);
    expect(notFound).toBeInstanceOf(HttpError);
    expect(notFound).not.toBeInstanceOf(RetryableHttpError);
    expect((notFound as HttpError).status).toBe(404);
  });

  it("records the call even when the status throws", async () => {
    const service = uniqueService();
    await expect(
      httpCall(stubTransport(500), { service, operation: "probe", url: "https://example.invalid/e", timeoutMs: 1000 }, { db }),
    ).rejects.toBeInstanceOf(RetryableHttpError);
    const rows = await db.select().from(externalCalls).where(eq(externalCalls.service, service));
    expect(rows.map((r) => r.meta)).toEqual([{ status: 500, bytes: 2 }]);
  });

  it("waits for the rate limit token", async () => {
    const service = uniqueService();
    let clock = new Date("2030-01-01T00:00:00Z").getTime();
    const slept: number[] = [];
    const deps = {
      now: () => new Date(clock),
      sleep: async (ms: number) => {
        slept.push(ms);
        clock += ms;
      },
    };
    const transport = stubTransport(200);
    const req = { service, operation: "probe", url: "https://example.invalid/r", timeoutMs: 1000, ratePerMinute: 2 };
    await httpCall(transport, req, { db }, deps);
    await httpCall(transport, req, { db }, deps);
    expect(slept).toEqual([]);
    await httpCall(transport, req, { db }, deps);
    expect(slept.length).toBeGreaterThan(0);
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(30_000);
    expect(transport.calls).toHaveLength(3);
  });

  it("gives up with RetryableHttpError when the token does not come within 60 s", async () => {
    const service = uniqueService();
    const frozen = new Date("2030-01-01T00:00:00Z");
    const slept: number[] = [];
    // The clock never advances, so the bucket never refills however long we "sleep".
    const deps = { now: () => frozen, sleep: async (ms: number) => void slept.push(ms) };
    const transport = stubTransport(200);
    const req = { service, operation: "probe", url: "https://example.invalid/r", timeoutMs: 1000, ratePerMinute: 1 };
    await httpCall(transport, req, { db }, deps);
    await expect(httpCall(transport, req, { db }, deps)).rejects.toBeInstanceOf(RetryableHttpError);
    expect(slept).toEqual([60_000]);
    expect(transport.calls).toHaveLength(1);
  });
});

describe("fixtures", () => {
  it("uses a stable sha256 key over method, url and body", () => {
    expect(fixtureKey({ url: "https://example.invalid/x" })).toBe(
      fixtureKey({ method: "GET", url: "https://example.invalid/x" }),
    );
    expect(fixtureKey({ url: "https://example.invalid/x" })).toMatch(/^[0-9a-f]{64}$/);
    expect(fixtureKey({ method: "POST", url: "https://example.invalid/x", body: "a" })).not.toBe(
      fixtureKey({ method: "POST", url: "https://example.invalid/x", body: "b" }),
    );
  });

  it("fixtureTransport fails loudly for an unknown request", async () => {
    const dir = await tempDir();
    await expect(
      fixtureTransport(dir)({ service: "svc", operation: "op", url: "https://example.invalid/none", timeoutMs: 1 }),
    ).rejects.toThrow("no fixture for svc GET https://example.invalid/none");
  });

  it("recordingTransport output is replayed by fixtureTransport", async () => {
    const dir = await tempDir();
    const req: HttpRequest = {
      service: "svc",
      operation: "op",
      url: "https://example.invalid/data",
      method: "POST",
      body: "data=1",
      timeoutMs: 1,
    };
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const inner: Transport = async () => makeResponse(418, bytes);
    const recorded = await recordingTransport(inner, dir, { recordErrors: true })(req);
    expect(recorded.status).toBe(418);

    const files = await readdir(join(dir, "svc"));
    expect(files).toEqual([`${fixtureKey(req)}.json`]);
    const stored = JSON.parse(await readFile(join(dir, "svc", files[0]!), "utf8"));
    expect(stored.request).toEqual({ method: "POST", url: "https://example.invalid/data", body: "data=1" });

    const replayed = await fixtureTransport(dir)(req);
    expect(replayed.status).toBe(418);
    expect(Array.from(replayed.body)).toEqual(Array.from(bytes));
  });

  it("recordingTransport passes a non-2xx answer through without recording it", async () => {
    const dir = await tempDir();
    const req: HttpRequest = { service: "svc", operation: "op", url: "https://example.invalid/busy", timeoutMs: 1 };
    for (const status of [429, 503, 302]) {
      const res = await recordingTransport(async () => makeResponse(status, new Uint8Array([1])), dir)(req);
      expect(res.status).toBe(status);
    }
    await expect(readdir(join(dir, "svc"))).rejects.toThrow(/ENOENT/);

    await recordingTransport(async () => makeResponse(204, new Uint8Array()), dir)(req);
    expect((await fixtureTransport(dir)(req)).status).toBe(204);
  });
});

describe("getTransport", () => {
  it("hands out the transport installed by the test setup and refuses under test without one", async () => {
    const installed = getTransport();
    expect(installed).not.toBe(fetchTransport);
    // test/setup.ts installs the fixture replay: an unrecorded request fails instead of reaching the network.
    await expect(installed({ service: "svc", operation: "op", url: "https://example.invalid/none", timeoutMs: 1 })).rejects.toThrow(
      "no fixture for svc GET https://example.invalid/none",
    );
    try {
      setTransport(undefined);
      expect(() => getTransport()).toThrow("no transport set under test");
      const stub = stubTransport(200);
      setTransport(stub);
      expect(getTransport()).toBe(stub);
    } finally {
      setTransport(installed);
    }
  });
});
