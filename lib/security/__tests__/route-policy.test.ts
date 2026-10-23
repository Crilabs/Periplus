import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchRoute, normalizePath, ROUTE_POLICY } from "../route-policy";

/** The delivery API routes (spec 08, spec 14: contract 3.0 under `/api/v3`; the 1.0 schemas stay under `/api/v1`). */
const DELIVERY_ROUTES = [
  "/api/v1/schema/[version]/[file]",
  "/api/v3/ping",
  "/api/v3/subdivisions",
  "/api/v3/subdivisions/[subdivision]/package",
  "/api/v3/subdivisions/[subdivision]/package/[file]",
  "/api/v3/schema/[version]/[file]",
  "/api/v3/subdivisions/[subdivision]/changes",
  "/api/v3/spots/[id]",
];

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

  it("the delivery admin pages and the file download need an admin session", () => {
    for (const route of ["/deliveries", "/deliveries/[id]", "/deliveries/[id]/files/[file]"]) {
      expect(ROUTE_POLICY[route], route).toEqual({ kind: "admin" });
    }
    expect(matchRoute("/deliveries/0199f0a0-0000-7000-8000-000000000001/files/spots.json")?.pattern).toBe("/deliveries/[id]/files/[file]");
  });

  it("gives /api/v1/ping the delivery:read scope", () => {
    expect(ROUTE_POLICY["/api/v1/ping"]).toEqual({ kind: "api", scope: "delivery:read" });
  });

  it("moved the delivery API from /api/v2 to /api/v3", () => {
    expect(Object.keys(ROUTE_POLICY).some((r) => r.startsWith("/api/v2/"))).toBe(false);
    expect(ROUTE_POLICY["/api/v3/subdivisions"]).toEqual({ kind: "api", scope: "delivery:read" });
  });

  it("every new api route is in the route policy with the delivery:read scope", () => {
    for (const route of DELIVERY_ROUTES) {
      expect(ROUTE_POLICY[route], route).toEqual({ kind: "api", scope: "delivery:read" });
    }
    for (const [path, pattern] of [
      ["/api/v3/subdivisions", "/api/v3/subdivisions"],
      ["/api/v3/subdivisions/sd_X/package", "/api/v3/subdivisions/[subdivision]/package"],
      ["/api/v3/subdivisions/GR-I/package/spots.json", "/api/v3/subdivisions/[subdivision]/package/[file]"],
      ["/api/v1/schema/1.0/spots.schema.json", "/api/v1/schema/[version]/[file]"],
      ["/api/v3/schema/2.0/spots.schema.json", "/api/v3/schema/[version]/[file]"],
      ["/api/v3/subdivisions/GR-I/changes", "/api/v3/subdivisions/[subdivision]/changes"],
      ["/api/v3/spots/sp_X", "/api/v3/spots/[id]"],
    ] as const) {
      expect(matchRoute(path)?.pattern, path).toBe(pattern);
    }
  });
});

describe("normalizePath", () => {
  it.each([
    ["/runs", "/runs"],
    ["/runs/", "/runs"],
    ["/", "/"],
    ["/Healthz", "/Healthz"],
    ["/runs/a%20b", "/runs/a b"],
    ["/tiles/q025%3A813%3A510", "/tiles/q025:813:510"],
    ["/tiles/q025:813:510", "/tiles/q025:813:510"],
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

  it("matches detail pages, including a tile id with `:` after decoding", () => {
    const tile = normalizePath("/tiles/q025%3A813%3A510");
    expect(tile).not.toBeNull();
    expect(matchRoute(tile!)).toEqual({ pattern: "/tiles/[id]", rule: { kind: "admin" } });
    expect(matchRoute("/tiles/q025:813:510")).toEqual({ pattern: "/tiles/[id]", rule: { kind: "admin" } });
    expect(matchRoute("/geo/0190a6c2-7a1b-7c3d-8e4f-0123456789ab")).toEqual({ pattern: "/geo/[id]", rule: { kind: "admin" } });
    expect(matchRoute("/places/0190a6c2-7a1b-7c3d-8e4f-0123456789ab")).toEqual({
      pattern: "/places/[id]",
      rule: { kind: "admin" },
    });
  });

  it("returns null for unknown or partially matching paths", () => {
    expect(matchRoute("/runs/abc/def")).toBeNull();
    expect(matchRoute("/api/v1/ping/x")).toBeNull();
    expect(matchRoute("/Healthz")).toBeNull();
  });
});

describe("contract 1.0 routes", () => {
  it("the area routes of contract 1.0 are gone: a key gets 404, not a package", () => {
    for (const path of ["/api/v1/areas", "/api/v1/areas/saronic/package", "/api/v1/spots/sp_X"]) expect(matchRoute(path), path).toBeNull();
  });
});
