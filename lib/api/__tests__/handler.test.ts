import { afterEach, describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { newId } from "@/lib/domain/ids";
import { createApiClient } from "@/lib/domain/api-clients";
import { setApiLimiter, withApiClient } from "@/lib/api/handler";

const db = testDb();
const reqWith = (key?: string) =>
  new Request("http://localhost/api/v1/x", { headers: key ? { authorization: `Bearer ${key}` } : {} });
const ok = async () => Response.json({ ok: true });

afterEach(() => setApiLimiter(async () => ({ ok: true })));

describe("withApiClient", () => {
  it("returns 401 without header, 403 with wrong scope, 200 with right scope", async () => {
    const { key } = await createApiClient(db, { name: `test-${newId()}`, scopes: ["delivery:read"] });
    const wrapped = withApiClient("delivery:read", ok);
    const none = await wrapped(reqWith());
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: { code: "unauthorized" } });
    const forbidden = await withApiClient("reports:write", ok)(reqWith(key));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: { code: "forbidden" } });
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
    expect(await res.json()).toEqual({ error: { code: "rate_limited" } });
  });

  it("hides thrown error messages", async () => {
    const { key } = await createApiClient(db, { name: `test-${newId()}`, scopes: ["delivery:read"] });
    const res = await withApiClient("delivery:read", async () => {
      throw new Error("db password xyz");
    })(reqWith(key));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("xyz");
  });
});
