import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { createApiClient } from "@/lib/domain/api-clients";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { setDeliveryArchive } from "@/lib/domain/delivery/read";
import { newId } from "@/lib/domain/ids";
import { testDb, withRollback } from "@/test/db";
import { seedDeliveryArea } from "@/test/fixtures/delivery/area";
import { memoryArchive } from "@/test/s3";
import { baseUrlWarning, consumePackage, parseArgs, resolveLink } from "../delivery-consume";

/*
 * The consumer check against the real route handlers: a `fetch` stub maps the URLs `consumePackage` calls onto the
 * handlers of `app/api/v1`, which read the test transaction (ruling M6-P21) and an in-memory archive. Build dates lie
 * in the future: the fixture's geo rows are valid from the database's `current_date`.
 */

let db: Db = testDb();

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));
vi.mock("@/lib/db/client", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/db/client")>()),
  getDb: () => db,
}));

const packageRoute = await import("@/app/api/v1/areas/[area]/package/route");
const fileRoute = await import("@/app/api/v1/areas/[area]/package/[file]/route");
const schemaRoute = await import("@/app/api/v1/schema/[version]/[file]/route");

const BASE = "https://periplus.test.invalid";
const NOW = new Date("2040-06-01T08:00:00Z");

/**
 * `fetch` onto the route handlers; `tamper` may rewrite a response body by path; `prefix` is the path the server is
 * mounted under (a reverse proxy strips it, the handlers' links do not carry it).
 */
function routeFetch(tamper?: (path: string, bytes: Uint8Array) => Uint8Array, prefix = ""): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== BASE) throw new Error(`unexpected origin ${url.origin}`);
    if (!url.pathname.startsWith(`${prefix}/`)) return new Response(null, { status: 404 });
    const parts = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent);
    // "", "api", "v1", …
    const [, api, v1, kind, a, b, c] = parts;
    if (api !== "api" || v1 !== "v1") return new Response(null, { status: 404 });
    let res: Response;
    if (kind === "areas" && b === "package" && c === undefined && parts.length === 6) {
      res = await packageRoute.GET(req, { params: Promise.resolve({ area: a! }) });
    } else if (kind === "areas" && b === "package" && c !== undefined && parts.length === 7) {
      res = await fileRoute.GET(req, { params: Promise.resolve({ area: a!, file: c }) });
    } else if (kind === "schema" && parts.length === 6) {
      res = await schemaRoute.GET(req, { params: Promise.resolve({ version: a!, file: b! }) });
    } else {
      return new Response(null, { status: 404 });
    }
    if (!tamper || res.status !== 200) return res;
    const bytes = tamper(url.pathname, new Uint8Array(await res.arrayBuffer()));
    return new Response(new Uint8Array(bytes), { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

/** The fixture area with its first package built and a reader key. */
async function builtArea(tx: Db) {
  db = tx;
  const archive = memoryArchive();
  setDeliveryArchive(archive);
  const f = await seedDeliveryArea(tx);
  const build = await buildDelivery(tx, archive, f.areaId, { now: NOW, inCallerTransaction: true });
  expect(build.status).toBe("valid");
  const { key } = await createApiClient(tx, { name: `test-${newId()}`, scopes: ["delivery:read"] });
  return { f, key };
}

beforeEach(() => {
  db = testDb();
});
afterEach(() => setDeliveryArchive(null));

describe("consumePackage", () => {
  it("a built package is consumed with matching hashes and no schema errors", () =>
    withRollback(async (tx) => {
      const { f, key } = await builtArea(tx);
      const result = await consumePackage({ baseUrl: `${BASE}/`, key, area: f.areaKey, fetch: routeFetch() });
      expect(result.dataVersion).toBe(1);
      expect(result.files.map((x) => x.name).sort()).toEqual(
        ["coast.geojson", "highlights.json", "manifest.json", "regions.json", "spots.json", "weather-points.json"].sort(),
      );
      for (const file of result.files) expect(file).toEqual({ name: file.name, sha256Ok: true, schemaErrors: [] });
      expect(result.ok).toBe(true);
      // the public id names the same area
      expect((await consumePackage({ baseUrl: BASE, key, area: f.areaPublicId, fetch: routeFetch() })).ok).toBe(true);
    }));

  it("a tampered file fails the hash check", () =>
    withRollback(async (tx) => {
      const { f, key } = await builtArea(tx);
      // still valid JSON of the contract, one byte more than the manifest describes
      const tamper = (path: string, bytes: Uint8Array) =>
        path.endsWith("/package/spots.json") ? new Uint8Array([...bytes, 0x0a]) : bytes;
      const result = await consumePackage({ baseUrl: BASE, key, area: f.areaKey, fetch: routeFetch(tamper) });
      expect(result.ok).toBe(false);
      expect(result.files.find((x) => x.name === "spots.json")).toEqual({ name: "spots.json", sha256Ok: false, schemaErrors: [] });
      expect(result.files.filter((x) => x.name !== "spots.json").every((x) => x.sha256Ok && x.schemaErrors.length === 0)).toBe(true);
    }));

  it("a file that breaks the published schema is reported with its path", () =>
    withRollback(async (tx) => {
      const { f, key } = await builtArea(tx);
      const tamper = (path: string, bytes: Uint8Array) => {
        if (!path.endsWith("/package/spots.json")) return bytes;
        const file = JSON.parse(new TextDecoder().decode(bytes)) as { spots: Array<Record<string, unknown>> };
        file.spots[0]!.kind = "lagoon";
        return new TextEncoder().encode(JSON.stringify(file));
      };
      const result = await consumePackage({ baseUrl: BASE, key, area: f.areaKey, fetch: routeFetch(tamper) });
      const spots = result.files.find((x) => x.name === "spots.json")!;
      expect(spots.sha256Ok).toBe(false);
      expect(spots.schemaErrors.some((e) => e.startsWith("/spots/0/kind"))).toBe(true);
      expect(result.ok).toBe(false);
    }));

  it("a base URL with a path prefix keeps it for every request (final review M-4)", () =>
    withRollback(async (tx) => {
      const { f, key } = await builtArea(tx);
      const result = await consumePackage({ baseUrl: `${BASE}/periplus/`, key, area: f.areaKey, fetch: routeFetch(undefined, "/periplus") });
      expect(result.ok).toBe(true);
      expect(result.files).toHaveLength(6);
    }));

  it("a manifest link to another origin is not fetched, so the key never leaves the base URL's host (bundle H review)", () =>
    withRollback(async (tx) => {
      const { f, key } = await builtArea(tx);
      const tamper = (path: string, bytes: Uint8Array) => {
        if (!path.endsWith("/package")) return bytes;
        const body = JSON.parse(new TextDecoder().decode(bytes)) as { links: Record<string, string> };
        body.links["spots.json"] = "https://elsewhere.test.invalid/api/v1/areas/x/package/spots.json";
        return new TextEncoder().encode(JSON.stringify(body));
      };
      // routeFetch throws on any other origin: the run completes, so nothing was sent there
      const result = await consumePackage({ baseUrl: BASE, key, area: f.areaKey, fetch: routeFetch(tamper) });
      expect(result.files.find((x) => x.name === "spots.json")).toEqual({
        name: "spots.json",
        sha256Ok: false,
        schemaErrors: ["link to another origin, not fetched: https://elsewhere.test.invalid/api/v1/areas/x/package/spots.json"],
      });
      expect(result.ok).toBe(false);
    }));

  it("a wrong key or an area without package throws with the API's error", () =>
    withRollback(async (tx) => {
      const { f, key } = await builtArea(tx);
      await expect(consumePackage({ baseUrl: BASE, key: "pk_wrong", area: f.areaKey, fetch: routeFetch() })).rejects.toThrow(
        /401 unauthorized: Missing or invalid API key\./,
      );
      await expect(consumePackage({ baseUrl: BASE, key, area: "no-such-area", fetch: routeFetch() })).rejects.toThrow(/404/);
    }));
});

describe("resolveLink and baseUrlWarning", () => {
  it("appends root-relative links to the base, accepts absolute links of the same origin only", () => {
    expect(resolveLink("https://h.example/periplus", "/api/v1/areas")).toBe("https://h.example/periplus/api/v1/areas");
    expect(resolveLink("https://h.example", "https://h.example/api/v1/x")).toBe("https://h.example/api/v1/x");
    expect(resolveLink("https://h.example", "https://other.example/api/v1/x")).toBeNull();
    expect(resolveLink("https://h.example", "//other.example/api/v1/x")).toBeNull();
    expect(resolveLink("https://h.example", "http://h.example/api/v1/x")).toBeNull();
  });

  it("warns on plain http except to localhost", () => {
    expect(baseUrlWarning("http://periplus.example.org")).toMatch(/plain http/);
    expect(baseUrlWarning("http://localhost:3000")).toBeNull();
    expect(baseUrlWarning("http://127.0.0.1:3200")).toBeNull();
    expect(baseUrlWarning("https://periplus.example.org")).toBeNull();
  });
});

describe("parseArgs", () => {
  it("reads base url, key and area; the key may come from PERIPLUS_API_KEY", () => {
    expect(parseArgs(["--base-url", "https://x.example", "--key", "pk_a", "--area", "saronic"], {})).toEqual({
      baseUrl: "https://x.example",
      key: "pk_a",
      area: "saronic",
    });
    expect(parseArgs(["--area", "saronic", "--base-url", "http://localhost:3000"], { PERIPLUS_API_KEY: "pk_env" })).toEqual({
      baseUrl: "http://localhost:3000",
      key: "pk_env",
      area: "saronic",
    });
  });

  it("refuses missing or unknown arguments", () => {
    expect(() => parseArgs(["--area", "saronic", "--key", "pk_a"], {})).toThrow(/usage/);
    expect(() => parseArgs(["--base-url", "http://x", "--area", "saronic"], {})).toThrow(/usage/);
    expect(() => parseArgs(["--base-url", "http://x", "--key", "pk_a", "--area", "saronic", "--verbose"], {})).toThrow(/usage/);
    expect(() => parseArgs(["--base-url", "ftp://x", "--key", "pk_a", "--area", "saronic"], {})).toThrow(/http/);
  });
});
