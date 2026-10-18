import { NextResponse, type NextRequest } from "next/server";
import { decideAccess } from "@/lib/security/access";
import { refreshSessionToken, SESSION_COOKIE, sessionCookieOptions, verifySessionToken } from "@/lib/security/session";

const BEARER = /^Bearer\s+\S+/i;

/** Default-deny gate for every request (see lib/security/route-policy.ts). Never touches the DB. */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  const decision = decideAccess({
    pathname: request.nextUrl.pathname,
    session,
    hasBearer: BEARER.test(request.headers.get("authorization") ?? ""),
  });

  // Next's proxy adapter requires an absolute Location (it parses it with NextURL) and rewrites a
  // same-host one to a relative path, so the client-controlled Host never reaches the browser.
  // Asserted end-to-end in e2e/login.spec.ts ("redirect Location is relative …").
  if (decision.action === "redirect") return NextResponse.redirect(new URL(decision.to, request.url));
  if (decision.action === "deny") {
    const code = decision.status === 401 ? "unauthorized" : "not_found";
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (decision.status === 401) headers["WWW-Authenticate"] = "Bearer";
    return NextResponse.json({ error: { code } }, { status: decision.status, headers });
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-trace-id", crypto.randomUUID());
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  if (session && shouldRefresh(request, session.iat)) {
    const refreshed = await refreshSessionToken(session);
    if (refreshed) response.cookies.set(SESSION_COOKIE, refreshed, sessionCookieOptions());
  }
  return response;
}

const REFRESH_AFTER_SECONDS = 3600;

/**
 * Slide the session only on real navigations, at most once an hour. Server actions (POST) may delete the
 * cookie themselves (logout), and router prefetches can still be in flight when logout completes; a refresh
 * Set-Cookie on either would race with the deletion and keep the session alive.
 */
function shouldRefresh(request: NextRequest, issuedAt: number): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (request.headers.has("next-router-prefetch") || request.headers.has("next-router-segment-prefetch")) return false;
  return Date.now() / 1000 - issuedAt >= REFRESH_AFTER_SECONDS;
}

export const config = {
  // Exact exclusions: `/_next/static/…`, `/_next/image…` and `/favicon.ico` only (tested in lib/security/__tests__/proxy.test.ts).
  matcher: ["/((?!_next/static/|_next/image|favicon\\.ico$).*)"],
};
