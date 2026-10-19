import type { ApiScope } from "@/lib/domain/api-clients";

export type RouteRule = { kind: "public" } | { kind: "auth" } | { kind: "admin" } | { kind: "api"; scope: ApiScope };

/**
 * Default-deny policy: every URL-producing route under `app/` (route groups stripped,
 * `[param]` kept) must be listed here. A route-policy test enforces the match both ways.
 */
export const ROUTE_POLICY: Record<string, RouteRule> = {
  "/": { kind: "admin" },
  "/login": { kind: "auth" },
  "/healthz": { kind: "public" },
  "/readyz": { kind: "public" },
  "/map": { kind: "admin" },
  "/map-data/[layer]": { kind: "admin" },
  "/runs": { kind: "admin" },
  "/runs/[id]": { kind: "admin" },
  "/jobs": { kind: "admin" },
  "/costs": { kind: "admin" },
  "/settings": { kind: "admin" },
  "/quality": { kind: "admin" },
  "/review": { kind: "admin" },
  "/review/[id]": { kind: "admin" },
  "/tiles/[id]": { kind: "admin" },
  "/geo/[id]": { kind: "admin" },
  "/places/[id]": { kind: "admin" },
  "/sources": { kind: "admin" },
  "/sources/[id]": { kind: "admin" },
  "/documents/[id]": { kind: "admin" },
  "/documents/[id]/raw/[versionId]": { kind: "admin" },
  "/compare/converters": { kind: "admin" },
  "/api/v1/ping": { kind: "api", scope: "delivery:read" },
};

const ENCODED_SEPARATOR = /%(2f|5c)/i;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Decodes the pathname exactly once and returns it without one trailing slash (case kept),
 * or null for anything ambiguous: encoded `/` or `\`, a second encoding layer, malformed
 * escapes, `..`/`.` segments, `\`, control characters, empty segments (`//`).
 */
export function normalizePath(pathname: string): string | null {
  if (!pathname.startsWith("/") || ENCODED_SEPARATOR.test(pathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (PERCENT_ESCAPE.test(decoded) || CONTROL_CHARS.test(decoded) || decoded.includes("\\")) return null;
  if (decoded.includes("..") || decoded.includes("//")) return null;
  const path = decoded.length > 1 && decoded.endsWith("/") ? decoded.slice(0, -1) : decoded;
  if (path.split("/").includes(".")) return null;
  return path;
}

const isParam = (segment: string) => /^\[[^\]]+\]$/.test(segment);

/** Matches a normalized path against ROUTE_POLICY; static patterns win over `[param]` patterns. */
export function matchRoute(path: string): { pattern: string; rule: RouteRule } | null {
  if (Object.hasOwn(ROUTE_POLICY, path)) return { pattern: path, rule: ROUTE_POLICY[path] };
  const segments = path.split("/");
  for (const [pattern, rule] of Object.entries(ROUTE_POLICY)) {
    const parts = pattern.split("/");
    if (!parts.some(isParam) || parts.length !== segments.length) continue;
    if (parts.every((part, i) => (isParam(part) ? segments[i] !== "" : part === segments[i]))) {
      return { pattern, rule };
    }
  }
  return null;
}
