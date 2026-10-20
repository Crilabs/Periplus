import { afterEach, describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { newId } from "@/lib/domain/ids";
import { createApiClient, revokeApiClient } from "@/lib/domain/api-clients";
import { setApiLimiter, withApiClient } from "@/lib/api/handler";

const db = testDb();
const reqWith = (key?: string) =>
  new Request("http://localhost/api/v1/x", { headers: key ? { authorization: `Bearer ${key}` } : {} });
const ok = async () => Response.json({ ok: true });

afterEach(() => setApiLimiter(null));

describe("withApiClient", () => {
  it("returns 401 without header, 403 with wrong scope, 200 with right scope", async () => {
    const { key } = await createApiClient(db, { name: `test-${newId()}`, scopes: ["delivery:read"] });
    const wrapped = withApiClient("delivery:read", ok);
    const none = await wrapped(reqWith());
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid API key." } });
    expect(none.headers.get("www-authenticate")).toBe("Bearer");
    const forbidden = await withApiClient("reports:write", ok)(reqWith(key));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: { code: "forbidden", message: "The API key lacks the required scope." } });
    const good = await wrapped(reqWith(key));
    expect(good.status).toBe(200);
    expect(good.headers.get("cache-control")).toBe("no-store");
  });

  it("lets the handler set its own Cache-Control", async () => {
    const { key } = await createApiClient(db, { name: `test-${newId()}`, scopes: ["delivery:read"] });
    const res = await withApiClient("delivery:read", async () =>
      Response.json({}, { headers: { "Cache-Control": "public, max-age=60" } }),
    )(reqWith(key));
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("returns 429 with Retry-After when the limiter rejects", async () => {
    const { key } = await createApiClient(db, { name: `test-${newId()}`, scopes: ["delivery:read"] });
    setApiLimiter(async () => ({ ok: false, retryAfterMs: 1500 }));
    const res = await withApiClient("delivery:read", ok)(reqWith(key));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toEqual({ error: { code: "rate_limited", message: "Rate limit exceeded." } });
  });

  it("returns 429 after the client's limit", async () => {
    const { key } = await createApiClient(db, { name: `test-${newId()}`, scopes: ["delivery:read"], rateLimitPerMin: 2 });
    const wrapped = withApiClient("delivery:read", ok);
    expect((await wrapped(reqWith(key))).status).toBe(200);
    expect((await wrapped(reqWith(key))).status).toBe(200);
    const third = await wrapped(reqWith(key));
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("hides thrown error messages", async () => {
    const { key } = await createApiClient(db, { name: `test-${newId()}`, scopes: ["delivery:read"] });
    const res = await withApiClient("delivery:read", async () => {
      throw new Error("db password xyz");
    })(reqWith(key));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("xyz");
    expect(JSON.parse(text)).toEqual({ error: { code: "internal", message: "Internal error." } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("errors carry code and message", async () =>
    expect(await (await withApiClient("delivery:read", ok)(reqWith())).json()).toEqual({
      error: { code: "unauthorized", message: "Missing or invalid API key." },
    }));

  it("401 with a malformed or revoked key, 403 with reports:write only", async () => {
    const { id, key } = await createApiClient(db, { name: `test-${newId()}`, scopes: ["delivery:read"] });
    const wrapped = withApiClient("delivery:read", ok);
    expect((await wrapped(reqWith(key))).status).toBe(200);
    expect((await wrapped(reqWith("pk_unknown"))).status).toBe(401);
    expect((await wrapped(new Request("http://localhost/api/v1/x", { headers: { authorization: `Basic ${key}` } }))).status).toBe(401);
    await revokeApiClient(db, id);
    const revoked = await wrapped(reqWith(key));
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid API key." } });
    const writer = await createApiClient(db, { name: `test-${newId()}`, scopes: ["reports:write"] });
    const forbidden = await wrapped(reqWith(writer.key));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe("forbidden");
  });

  it("passes the route context through to the handler", async () => {
    const { key } = await createApiClient(db, { name: `test-${newId()}`, scopes: ["delivery:read"] });
    const wrapped = withApiClient<{ params: Promise<{ area: string }> }>("delivery:read", async (_req, client, ctx) =>
      Response.json({ area: (await ctx.params).area, client: client.name.startsWith("test-") }),
    );
    const res = await wrapped(reqWith(key), { params: Promise.resolve({ area: "saronic" }) });
    expect(await res.json()).toEqual({ area: "saronic", client: true });
  });
});
