import { matchRoute, normalizePath } from "./route-policy";
import type { SessionClaims } from "./session";

export type AccessDecision =
  | { action: "allow" }
  | { action: "redirect"; to: string }
  | { action: "deny"; status: 401 | 404 };

const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");

/**
 * The single access decision for admin UI and API. Pure: no I/O.
 * API keys are verified later in `withApiClient`; here only their presence counts,
 * and a session never stands in for API credentials.
 */
export function decideAccess(input: { pathname: string; session: SessionClaims | null; hasBearer: boolean }): AccessDecision {
  const path = normalizePath(input.pathname);
  if (path === null) return { action: "deny", status: 404 };

  const match = matchRoute(path);
  // The MCP route answers its own 401 (with its text and WWW-Authenticate) and its 403 for browsers.
  if (match?.rule.kind === "mcp") return { action: "allow" };
  if (isApiPath(path) || match?.rule.kind === "api") {
    if (!input.hasBearer) return { action: "deny", status: 401 };
    if (match?.rule.kind !== "api") return { action: "deny", status: 404 };
    return { action: "allow" };
  }

  if (match?.rule.kind === "public" || match?.rule.kind === "auth") return { action: "allow" };
  if (!input.session) return { action: "redirect", to: `/login?next=${encodeURIComponent(path)}` };
  return { action: "allow" };
}
