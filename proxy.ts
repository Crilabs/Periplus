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
  if (session) {
    const refreshed = await refreshSessionToken(session);
    if (refreshed) response.cookies.set(SESSION_COOKIE, refreshed, sessionCookieOptions());
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
