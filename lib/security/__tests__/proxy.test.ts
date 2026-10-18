import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "@/proxy";

// Next's own matcher compiler (internal, untyped), so the test checks the regex `next build` produces.
const { getMiddlewareMatchers } = createRequire(import.meta.url)("next/dist/build/analysis/get-page-static-info.js") as {
  getMiddlewareMatchers: (matcher: string[], nextConfig: object) => Array<{ regexp: string }>;
};

function matches(pathname: string): boolean {
  return getMiddlewareMatchers(config.matcher, {}).some((m) => new RegExp(m.regexp).test(pathname));
}

describe("proxy matcher", () => {
  it("excludes only the exact static paths", () => {
    expect(matches("/favicon.ico")).toBe(false);
    expect(matches("/_next/static/chunks/app.js")).toBe(false);
    expect(matches("/_next/image")).toBe(false);
  });

  it("includes look-alike paths and app routes", () => {
    expect(matches("/favicon.ico.x")).toBe(true);
    expect(matches("/faviconXico")).toBe(true);
    expect(matches("/_next/staticfoo")).toBe(true);
    expect(matches("/runs")).toBe(true);
    expect(matches("/")).toBe(true);
  });
});

describe("proxy redirect", () => {
  // The relative Location the browser sees is produced by Next's adapter; see e2e/login.spec.ts.
  it("redirects an anonymous admin request to the login page with next", async () => {
    const response = await proxy(new NextRequest("http://localhost:3000/runs?x=1"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname + location.search).toBe("/login?next=%2Fruns");
  });
});

describe("proxy session refresh", () => {
  async function sessionCookie(): Promise<string> {
    const { createSessionToken, SESSION_COOKIE } = await import("@/lib/security/session");
    return `${SESSION_COOKIE}=${await createSessionToken({ id: "00000000-0000-7000-8000-000000000001", email: "a@test.invalid" })}`;
  }

  it("refreshes the session cookie on a GET page request", async () => {
    const response = await proxy(new NextRequest("http://localhost:3000/runs", { headers: { cookie: await sessionCookie() } }));
    expect(response.headers.get("set-cookie")).toMatch(/periplus_session=/);
  });

  it("never sets the session cookie on a server action POST (logout must win)", async () => {
    const response = await proxy(
      new NextRequest("http://localhost:3000/runs", {
        method: "POST",
        headers: { cookie: await sessionCookie(), "next-action": "abc123" },
      }),
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
