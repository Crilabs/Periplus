import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchRoute, normalizePath, ROUTE_POLICY } from "../route-policy";

const ROUTE_FILES = /^(page|route)\.(tsx?|jsx?)$/;

/** URL patterns of every page/route file under `dir`: strips (groups), keeps [params], skips _private folders. */
function collectRoutes(dir: string, segments: string[] = []): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && ROUTE_FILES.test(entry.name)) out.push("/" + segments.join("/"));
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const isGroup = /^\(.*\)$/.test(entry.name);
    out.push(...collectRoutes(join(dir, entry.name), isGroup ? segments : [...segments, entry.name]));
  }
  return [...new Set(out)];
}

describe("ROUTE_POLICY", () => {
  it("every page.tsx and route.ts under app/ has a policy entry and vice versa", () => {
    const routes = collectRoutes("app");
    expect(Object.keys(ROUTE_POLICY).sort()).toEqual(routes.sort());
  });

  it("gives /api/v1/ping the delivery:read scope", () => {
    expect(ROUTE_POLICY["/api/v1/ping"]).toEqual({ kind: "api", scope: "delivery:read" });
  });
});

describe("normalizePath", () => {
  it.each([
    ["/runs", "/runs"],
    ["/runs/", "/runs"],
    ["/", "/"],
    ["/Healthz", "/Healthz"],
    ["/runs/a%20b", "/runs/a b"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it.each([
    "/runs%2F..%2Fhealthz",
    "/runs%2fx",
    "/runs%5Cx",
    "/runs%5cx",
    "/runs/../healthz",
    "/runs/%2E%2E/healthz",
    "/api/v1//ping",
    "//runs",
    "/runs//",
    "/runs%252Fx",
    "/runs%2525",
    "/runs/%E0%A4%A",
    "/runs\\x",
    "/runs/%00",
    "runs",
    "",
  ])("rejects %s", (input) => {
    expect(normalizePath(input)).toBeNull();
  });
});

describe("matchRoute", () => {
  it("matches static and dynamic patterns", () => {
    expect(matchRoute("/runs")).toEqual({ pattern: "/runs", rule: { kind: "admin" } });
    expect(matchRoute("/runs/abc")).toEqual({ pattern: "/runs/[id]", rule: { kind: "admin" } });
    expect(matchRoute("/")).toEqual({ pattern: "/", rule: { kind: "admin" } });
  });

  it("returns null for unknown or partially matching paths", () => {
    expect(matchRoute("/runs/abc/def")).toBeNull();
    expect(matchRoute("/api/v1/ping/x")).toBeNull();
    expect(matchRoute("/Healthz")).toBeNull();
  });
});
