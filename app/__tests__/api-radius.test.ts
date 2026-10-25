import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changesResponseSchema, type Manifest } from "@/contract";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { createApiClient } from "@/lib/domain/api-clients";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { setDeliveryArchive } from "@/lib/domain/delivery/read";
import { sha256Hex } from "@/lib/domain/delivery/serialize";
import { newId } from "@/lib/domain/ids";
import { testDb, withRollback } from "@/test/db";
import { seedDeliverySubdivision } from "@/test/fixtures/delivery/subdivision";
import { memoryArchive } from "@/test/s3";
import { eastPackage, insertSecondSubdivision, storeSubdivisionPackage } from "@/test/fixtures/delivery/radius";
import { radiusPackageRequests, radiusPackages } from "@/lib/db/schema";

/*
 * The radius delivery API (spec 18, plan Task 7): package, files, changes and home marinas under `/api/v4`, called
 * directly with the test transaction as database on the built fixture subdivision.
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

const packageRoute = await import("../api/v4/radius/package/route");
const fileRoute = await import("../api/v4/radius/package/[file]/route");
const imageRoute = await import("../api/v4/radius/package/images/[file]/route");
const changesRoute = await import("../api/v4/radius/changes/route");
const homeRoute = await import("../api/v4/home-marinas/route");

const NOW = new Date("2040-06-01T08:00:00Z");
const BASE = "http://localhost/api/v4";

const request = (path: string, key?: string) => new Request(`${BASE}${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
const getPackage = (query: string, key?: string) => packageRoute.GET(request(`/radius/package${query}`, key));
const getFile = (file: string, query: string, key?: string) =>
  fileRoute.GET(request(`/radius/package/${encodeURIComponent(file)}${query}`, key), { params: Promise.resolve({ file }) });
const getImage = (file: string, query: string, key?: string) =>
  imageRoute.GET(request(`/radius/package/images/${encodeURIComponent(file)}${query}`, key), { params: Promise.resolve({ file }) });
const getChanges = (query: string, key?: string) => changesRoute.GET(request(`/radius/changes${query}`, key));
const getHome = (query = "", key?: string) => homeRoute.GET(request(`/home-marinas${query}`, key));

async function setup(tx: Db, archive: Archive = memoryArchive()) {
  db = tx;
  setDeliveryArchive(archive);
  const f = await seedDeliverySubdivision(tx);
  const built = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
  expect(built.status).toBe("valid");
  const { key } = await createApiClient(tx, { name: `test-${newId()}`, scopes: ["delivery:read"] });
  return { f, archive, key, marina: f.places.M.publicId! };
}

beforeEach(() => {
  db = testDb();
});
afterEach(() => setDeliveryArchive(null));

describe("GET /api/v4/radius/package", () => {
  it("answers the manifest with links to every file, pinned to the package key", () =>
    withRollback(async (tx) => {
      const { key, marina } = await setup(tx);
      const res = await getPackage(`?marina=${marina}&days=1`, key);
      expect(res.status).toBe(200);
      expect(res.headers.get("periplus-schema-version")).toBe("4.0");
      expect(res.headers.has("periplus-data-version")).toBe(false);
      const body = (await res.json()) as Manifest & { links: Record<string, string> };
      expect(body.scope.type).toBe("radius");
      expect(body.files.map((f) => f.name).sort()).toEqual(Object.keys(body.links).filter((n) => n !== "manifest.json").sort());
      const pkgKey = new URL(`http://x${body.links["spots.json"]}`).searchParams.get("key")!;
      expect(body.links["spots.json"]).toBe(`/api/v4/radius/package/spots.json?marina=${marina}&days=1&key=${pkgKey}`);
    }));

  it("links resolve to bytes whose hash is the manifest's", () =>
    withRollback(async (tx) => {
      const { key, marina } = await setup(tx);
      const body = (await (await getPackage(`?marina=${marina}&days=1`, key)).json()) as Manifest & { links: Record<string, string> };
      for (const file of body.files) {
        const url = new URL(`http://x${body.links[file.name]}`);
        const res = file.name.startsWith("images/")
          ? await getImage(file.name.slice("images/".length), url.search, key)
          : await getFile(file.name, url.search, key);
        expect(res.status, file.name).toBe(200);
        const bytes = new Uint8Array(await res.arrayBuffer());
        expect(sha256Hex(bytes), file.name).toBe(file.sha256);
      }
    }));

  it("rejects days outside 1-28 or not an integer with 400 invalid_days", () =>
    withRollback(async (tx) => {
      const { key, marina } = await setup(tx);
      for (const days of ["0", "7.5", "29", "abc", ""]) {
        const res = await getPackage(`?marina=${marina}&days=${days}`, key);
        expect(res.status, days).toBe(400);
        expect(((await res.json()) as { error: { code: string; message: string } }).error).toMatchObject({
          code: "invalid_days",
          message: "days must be an integer from 1 to 28.",
        });
      }
      expect((await getPackage(`?marina=${marina}`, key)).status).toBe(400);
    }));

  it("answers 404 for an unknown marina and for an anchorage", () =>
    withRollback(async (tx) => {
      const { key, f } = await setup(tx);
      expect((await getPackage("?marina=sp_01J9ZZ00000000000000000009&days=1", key)).status).toBe(404);
      expect((await getPackage(`?marina=${f.places.A.publicId}&days=1`, key)).status).toBe(404);
    }));

  it("answers 401 without an API key", () =>
    withRollback(async (tx) => {
      const { marina } = await setup(tx);
      expect((await getPackage(`?marina=${marina}&days=1`)).status).toBe(401);
      expect((await getChanges(`?marina=${marina}&days=1&since=x`)).status).toBe(401);
      expect((await getHome()).status).toBe(401);
    }));
});

describe("GET /api/v4/radius/package/{file}", () => {
  it("rejects a missing or foreign key with 400 invalid_key, an unlisted file with 404", () =>
    withRollback(async (tx) => {
      const { key, marina } = await setup(tx);
      const body = (await (await getPackage(`?marina=${marina}&days=1`, key)).json()) as { links: Record<string, string> };
      const pkgKey = new URL(`http://x${body.links["spots.json"]}`).searchParams.get("key")!;
      for (const query of [`?marina=${marina}&days=1`, `?marina=${marina}&days=1&key=0000000000000000`, `?marina=${marina}&days=2&key=${pkgKey}`]) {
        const res = await getFile("spots.json", query, key);
        expect(res.status, query).toBe(400);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_key");
      }
      expect((await getFile("changes.json", `?marina=${marina}&days=1&key=${pkgKey}`, key)).status).toBe(404);
      expect((await getFile("nothing.json", `?marina=${marina}&days=1&key=${pkgKey}`, key)).status).toBe(404);
    }));

  it("answers 304 for a matching If-None-Match", () =>
    withRollback(async (tx) => {
      const { key, marina } = await setup(tx);
      const body = (await (await getPackage(`?marina=${marina}&days=1`, key)).json()) as { links: Record<string, string> };
      const query = new URL(`http://x${body.links["spots.json"]}`).search;
      const first = await getFile("spots.json", query, key);
      const etag = first.headers.get("etag")!;
      const again = await fileRoute.GET(
        new Request(`${BASE}/radius/package/spots.json${query}`, { headers: { authorization: `Bearer ${key}`, "if-none-match": etag } }),
        { params: Promise.resolve({ file: "spots.json" }) },
      );
      expect(again.status).toBe(304);
    }));
});

describe("radius package requests", () => {
  it("a file fetched after a subdivision got a new delivery serves the pinned package and logs on it", () =>
    withRollback(async (tx) => {
      const { key, marina, archive } = await setup(tx);
      const east = await insertSecondSubdivision(tx);
      const body = (await (await getPackage(`?marina=${marina}&days=1`, key)).json()) as Manifest & { links: Record<string, string> };
      const spots = body.files.find((f) => f.name === "spots.json")!;
      const query = new URL(`http://x${body.links["spots.json"]}`).search;
      const ofMarina = () => tx.select().from(radiusPackages).where(eq(radiusPackages.homeMarinaPublicId, marina));
      const pinned = (await ofMarina())[0]!;
      // the east subdivision gets a package: the current key for marina and days is another one now
      await storeSubdivisionPackage(tx, archive, { subdivisionId: east.id, pkg: eastPackage(), dataVersion: 1 });
      const res = await getFile("spots.json", query, key);
      expect(res.status).toBe(200);
      expect(sha256Hex(new Uint8Array(await res.arrayBuffer()))).toBe(spots.sha256);
      expect(await ofMarina()).toHaveLength(1);
      const requests = await tx.select().from(radiusPackageRequests).where(eq(radiusPackageRequests.radiusPackageId, pinned.id));
      expect(requests.map((r) => [r.radiusPackageId, r.kind])).toEqual([
        [pinned.id, "package"],
        [pinned.id, "file"],
      ]);
      expect(requests[0]!.apiClientId).not.toBeNull();
    }));
});

describe("GET /api/v4/radius/changes", () => {
  it("answers 200 invalidSince reload whatever the key (there is no change feed in 4.0)", () =>
    withRollback(async (tx) => {
      const { key, marina } = await setup(tx);
      const body = (await (await getPackage(`?marina=${marina}&days=1`, key)).json()) as { links: Record<string, string> };
      const pkgKey = new URL(`http://x${body.links["spots.json"]}`).searchParams.get("key")!;
      for (const query of [`?marina=${marina}&days=1&since=${pkgKey}`, `?marina=${marina}&days=1&since=ffffffffffffffff`, `?marina=${marina}&days=1`]) {
        const res = await getChanges(query, key);
        expect(res.status, query).toBe(200);
        expect(res.headers.get("periplus-schema-version")).toBe("4.0");
        const answer = await res.json();
        expect(answer).toEqual({ invalidSince: true, reason: "reload" });
        expect(changesResponseSchema.safeParse(answer).success).toBe(true);
      }
    }));
});

describe("/api/v3", () => {
  it("is gone: no route directory of the old version is left", () => {
    expect(existsSync(fileURLToPath(new URL("../api/v3", import.meta.url)))).toBe(false);
  });
});

describe("GET /api/v4/home-marinas", () => {
  it("lists the fixture marina and no anchorage", () =>
    withRollback(async (tx) => {
      const { key, marina, f } = await setup(tx);
      const res = await getHome("?bbox=20,34,23,36", key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { schemaVersion: string; marinas: Array<{ id: string; name: string; position: { lon: number; lat: number }; subdivision: string }> };
      expect(body.schemaVersion).toBe("4.0");
      const ids = body.marinas.map((m) => m.id);
      expect(ids).toContain(marina);
      expect(ids).not.toContain(f.places.A.publicId);
      expect(body.marinas.find((m) => m.id === marina)!.subdivision).toBe(f.subdivisionPublicId);
    }));

  it("filters by bbox and rejects an invalid one", () =>
    withRollback(async (tx) => {
      const { key, marina } = await setup(tx);
      const inside = (await (await getHome("?bbox=20,34,23,36", key)).json()) as { marinas: Array<{ id: string }> };
      expect(inside.marinas.map((m) => m.id)).toContain(marina);
      const outside = (await (await getHome("?bbox=0,0,1,1", key)).json()) as { marinas: Array<{ id: string }> };
      expect(outside.marinas).toEqual([]);
      for (const bbox of ["1,2,3", "a,b,c,d", "5,0,1,1", "0,5,1,1", "0,0,181,1", "0,-91,1,1"]) {
        const res = await getHome(`?bbox=${bbox}`, key);
        expect(res.status, bbox).toBe(400);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_bbox");
      }
    }));
});
