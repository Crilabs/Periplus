import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Manifest, SpotsFile } from "@/contract";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { profileSummaries, textShingles } from "@/lib/db/schema";
import { createApiClient, revokeApiClient } from "@/lib/domain/api-clients";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { setDeliveryArchive } from "@/lib/domain/delivery/read";
import { sha256Hex } from "@/lib/domain/delivery/serialize";
import { shingleHashes } from "@/lib/domain/documents/shingles";
import { newId } from "@/lib/domain/ids";
import { decideAccess } from "@/lib/security/access";
import { insertProfile, provenanceEntry } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";
import { seedDeliveryArea, SPOT_A_ATTRIBUTES, spotAProvenance, type DeliveryFixture } from "@/test/fixtures/delivery/area";
import { deleteTestObjects, memoryArchive, testArchive } from "@/test/s3";
import { insertTestVersion } from "@/test/text";

/*
 * The delivery API's area, package, file and schema endpoints (plan Task 11), called directly with the test
 * transaction as database (ruling M6-P21) and packages built by `buildDelivery` on the fixture area. Build dates lie in
 * the future: the fixture's geo rows are valid from the database's `current_date`.
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

const areasRoute = await import("../api/v1/areas/route");
const packageRoute = await import("../api/v1/areas/[area]/package/route");
const fileRoute = await import("../api/v1/areas/[area]/package/[file]/route");
const schemaRoute = await import("../api/v1/schema/[version]/[file]/route");

const NOW = new Date("2040-06-01T08:00:00Z");
const LATER = new Date("2040-06-02T08:00:00Z");
const BASE = "http://localhost/api/v1";

const request = (path: string, key?: string, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });
const getAreas = (key?: string, headers?: Record<string, string>) => areasRoute.GET(request("/areas", key, headers));
const getPackage = (area: string, key?: string, headers?: Record<string, string>) =>
  packageRoute.GET(request(`/areas/${area}/package`, key, headers), { params: Promise.resolve({ area }) });
const getFile = (area: string, file: string, key?: string, query = "", headers?: Record<string, string>) =>
  fileRoute.GET(request(`/areas/${area}/package/${encodeURIComponent(file)}${query}`, key, headers), { params: Promise.resolve({ area, file }) });
const getSchema = (version: string, file: string, key?: string) =>
  schemaRoute.GET(request(`/schema/${version}/${file}`, key), { params: Promise.resolve({ version, file }) });

const reader = (tx: Db) => createApiClient(tx, { name: `test-${newId()}`, scopes: ["delivery:read"] });
const build = (tx: Db, archive: Archive, f: DeliveryFixture, now = NOW) =>
  buildDelivery(tx, archive, f.areaId, { now, inCallerTransaction: true });

/** The test transaction as database, an in-memory archive behind the API, the fixture area and a reader key. */
async function setup(tx: Db, archive: Archive = memoryArchive()) {
  db = tx;
  setDeliveryArchive(archive);
  const f = await seedDeliveryArea(tx);
  const { key } = await reader(tx);
  return { f, archive, key };
}

/** A second profile version of A with a changed east shelter: the next build is data version 2. */
async function changeA(tx: Db, f: DeliveryFixture): Promise<void> {
  await insertProfile(
    tx,
    f.places.A.geoObjectId,
    { ...SPOT_A_ATTRIBUTES, anchor_position: { lon: 21.1301, lat: 35.1445 }, "place.position": { lon: f.positions.A[0], lat: f.positions.A[1] }, "shelter.E": 0.8 },
    { ...spotAProvenance(f.factId), "place.position": provenanceEntry("gazetteer", { confidence: 1 }) },
    { version: 2, sourcesCount: 3, documentsCount: 1, confidence: 0.72 },
  );
  await tx.insert(profileSummaries).values({
    geoObjectId: f.places.A.geoObjectId,
    profileVersion: 2,
    text: "Tiefe Bucht mit gutem Schutz von West bis Nord, Sandgrund mit Seegras.",
    status: "ok",
    attempts: 1,
    model: "test",
    promptVersion: 1,
  });
}

/** A's summary becomes a 16-word copy of an archived text: the next build is rejected (`verbatim_text`). */
async function copySummaryOfA(tx: Db, f: DeliveryFixture, profileVersion = 1): Promise<void> {
  const salt = newId().replace(/-/g, "").replace(/\d/g, (d) => "ghijklmnop"[Number(d)]!);
  const words = Array.from({ length: 30 }, (_, i) => `${salt}${"abcdefghijklmnopqrstuvwxyz"[i % 26]}`);
  const v = await insertTestVersion(tx, [words.join(" ")]);
  await tx.insert(textShingles).values(shingleHashes(words.join(" "), 15).map((shingleHash) => ({ shingleHash, chunkId: v.chunkIds[0]! })));
  await tx.insert(profileSummaries).values({
    geoObjectId: f.places.A.geoObjectId,
    profileVersion,
    text: `Die Bucht: ${words.slice(2, 18).join(" ")}.`,
    status: "ok",
    attempts: 1,
    model: "test",
    promptVersion: 9,
  });
}

beforeEach(() => {
  db = testDb();
});
afterEach(() => setDeliveryArchive(null));

describe("delivery API: authentication", () => {
  it("errors carry code and message", async () => {
    const res = await getAreas();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid API key." } });
  });

  it("401 without key, 401 with a revoked key, 403 with reports:write only", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      const writer = await createApiClient(tx, { name: `test-${newId()}`, scopes: ["reports:write"] });
      const revoked = await reader(tx);
      await revokeApiClient(tx, revoked.id);
      const calls = [
        (k?: string) => getAreas(k),
        (k?: string) => getPackage(f.areaPublicId, k),
        (k?: string) => getFile(f.areaPublicId, "spots.json", k),
        (k?: string) => getSchema("1.0", "spots.schema.json", k),
      ];
      for (const call of calls) {
        expect((await call()).status).toBe(401);
        const gone = await call(revoked.key);
        expect(gone.status).toBe(401);
        expect(await gone.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid API key." } });
        const forbidden = await call(writer.key);
        expect(forbidden.status).toBe(403);
        expect(await forbidden.json()).toEqual({ error: { code: "forbidden", message: "The API key lacks the required scope." } });
        expect((await call(key)).status).toBe(200);
      }
    }));
});

describe("GET /api/v1/areas", () => {
  it("lists the area with the data version, bbox and build time of its latest valid package", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      const before = await getAreas(key);
      expect(before.status).toBe(200);
      const listed = (await before.json()) as { schemaVersion: string; areas: Array<{ id: string }> };
      expect(listed.schemaVersion).toBe("1.0");
      expect(listed.areas.find((a) => a.id === f.areaPublicId)).toEqual({
        id: f.areaPublicId,
        key: f.areaKey,
        name: "Testrevier",
        dataVersion: null,
        bbox: null,
        generatedAt: null,
      });

      await build(tx, archive, f);
      const manifest = JSON.parse(new TextDecoder().decode((await archive.get(`deliveries/${f.areaPublicId}/1/manifest.json`))!)) as Manifest;
      const res = await getAreas(key);
      expect(res.headers.has("periplus-data-version")).toBe(false);
      const body = (await res.json()) as { areas: Array<{ id: string }> };
      expect(body.areas.find((a) => a.id === f.areaPublicId)).toEqual({
        id: f.areaPublicId,
        key: f.areaKey,
        name: "Testrevier",
        dataVersion: 1,
        bbox: manifest.bbox,
        generatedAt: NOW.toISOString(),
      });
    }));
});

describe("GET /api/v1/areas/[area]/package", () => {
  it("the package manifest links every file of the current data version", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      await changeA(tx, f);
      expect(await build(tx, archive, f, LATER)).toMatchObject({ status: "valid", dataVersion: 2 });

      // by public id and by config key
      for (const ref of [f.areaPublicId, f.areaKey]) {
        const res = await getPackage(ref, key);
        expect(res.status, ref).toBe(200);
        expect(res.headers.get("periplus-data-version")).toBe("2");
        const body = (await res.json()) as Manifest & { links: Record<string, string> };
        const stored = JSON.parse(new TextDecoder().decode((await archive.get(`deliveries/${f.areaPublicId}/2/manifest.json`))!)) as Manifest;
        const { links, ...manifest } = body;
        expect(manifest).toEqual(stored);
        expect(links).toEqual(
          Object.fromEntries(
            ["manifest.json", "spots.json", "highlights.json", "regions.json", "coast.geojson", "weather-points.json", "changes.json"].map((file) => [
              file,
              `/api/v1/areas/${f.areaPublicId}/package/${file}?dataVersion=2`,
            ]),
          ),
        );
      }
    }));

  it("the first package has no changes.json link; an unknown area or one without a package is 404", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      const none = await getPackage(f.areaPublicId, key);
      expect(none.status).toBe(404);
      expect(await none.json()).toEqual({ error: { code: "not_found", message: "Not found." } });
      await build(tx, archive, f);
      const body = (await (await getPackage(f.areaPublicId, key)).json()) as { links: Record<string, string> };
      expect(Object.keys(body.links)).not.toContain("changes.json");
      expect(Object.keys(body.links)).toHaveLength(6);
      expect((await getPackage("ar_01J9ZD00000000000000000999", key)).status).toBe(404);
      expect((await getPackage("unknown-area", key)).status).toBe(404);
      // an island is no area
      expect((await getPackage(f.islandPublicId, key)).status).toBe(404);
    }));
});

describe("GET /api/v1/areas/[area]/package/[file]", () => {
  it("a file is served byte-identical to the manifest hash with schema and data version headers", async () => {
    // the one S3 round trip: the files go to the test bucket and are deleted afterwards
    const archive = testArchive();
    await archive.ensureBucket();
    const keys: string[] = [];
    try {
      await withRollback(async (tx) => {
        const { f, key } = await setup(tx, archive);
        await build(tx, archive, f);
        const prefix = `deliveries/${f.areaPublicId}/1/`;
        keys.push(...["manifest.json", "spots.json", "highlights.json", "regions.json", "coast.geojson", "weather-points.json"].map((n) => prefix + n));
        const manifest = (await (await getFile(f.areaPublicId, "manifest.json", key)).json()) as Manifest;
        for (const entry of manifest.files) {
          const res = await getFile(f.areaPublicId, entry.name, key);
          expect(res.status, entry.name).toBe(200);
          const bytes = new Uint8Array(await res.arrayBuffer());
          expect(sha256Hex(bytes), entry.name).toBe(entry.sha256);
          expect(bytes.byteLength).toBe(entry.bytes);
          expect(bytes).toEqual(await archive.get(prefix + entry.name));
          expect(res.headers.get("periplus-schema-version")).toBe("1.0");
          expect(res.headers.get("periplus-data-version")).toBe("1");
          expect(res.headers.get("content-type")).toBe(entry.name === "coast.geojson" ? "application/geo+json" : "application/json");
          expect(res.headers.get("etag")).toBe(`"${entry.sha256.slice(0, 32)}"`);
        }
      });
    } finally {
      await deleteTestObjects(keys);
    }
  });

  it("an older data version is served from the archive", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      await changeA(tx, f);
      await build(tx, archive, f, LATER);
      const spotA = async (query: string) => {
        const res = await getFile(f.areaPublicId, "spots.json", key, query);
        expect(res.status, query).toBe(200);
        return { version: res.headers.get("periplus-data-version"), a: ((await res.json()) as SpotsFile).spots.find((s) => s.id === f.places.A.publicId)! };
      };
      expect(await spotA("")).toMatchObject({ version: "2", a: { profileVersion: 2 } });
      expect(await spotA("?dataVersion=1")).toMatchObject({ version: "1", a: { profileVersion: 1, validFrom: "2040-06-01" } });
      const v1 = new Uint8Array(await (await getFile(f.areaPublicId, "spots.json", key, "?dataVersion=1")).arrayBuffer());
      expect(v1).toEqual(await archive.get(`deliveries/${f.areaPublicId}/1/spots.json`));
      // the first package has no change file
      expect((await getFile(f.areaPublicId, "changes.json", key, "?dataVersion=1")).status).toBe(404);
      expect((await getFile(f.areaPublicId, "changes.json", key, "?dataVersion=2")).status).toBe(200);

      for (const bad of ["0", "-1", "01", "1.0", "abc", "", "1e1"]) {
        const res = await getFile(f.areaPublicId, "spots.json", key, `?dataVersion=${bad}`);
        expect(res.status, bad).toBe(400);
        expect(await res.json()).toEqual({ error: { code: "invalid_data_version", message: "dataVersion must be a positive integer." } });
      }
      for (const unknown of ["3", "99999999999"]) {
        const res = await getFile(f.areaPublicId, "spots.json", key, `?dataVersion=${unknown}`);
        expect(res.status, unknown).toBe(404);
        expect((await res.json()).error.code).toBe("not_found");
      }
    }));

  it("unknown file and traversal are 404", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      // the proxy rejects an encoded separator before any route runs
      expect(decideAccess({ pathname: `/api/v1/areas/${f.areaPublicId}/package/..%2fspots.json`, session: null, hasBearer: true })).toEqual({
        action: "deny",
        status: 404,
      });
      expect(decideAccess({ pathname: `/api/v1/areas/${f.areaPublicId}/package/../spots.json`, session: null, hasBearer: true })).toEqual({
        action: "deny",
        status: 404,
      });
      expect(decideAccess({ pathname: `/api/v1/areas/${f.areaPublicId}/package/secrets.json`, session: null, hasBearer: true })).toEqual({
        action: "allow",
      });
      // the route serves contract files only
      for (const file of ["secrets.json", "../spots.json", "..%2fspots.json", "spots.json/", "SPOTS.JSON", "manifest"]) {
        const res = await getFile(f.areaPublicId, file, key);
        expect(res.status, file).toBe(404);
        expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found." } });
      }
    }));

  it("If-None-Match returns 304", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      for (const call of [
        (h?: Record<string, string>) => getFile(f.areaPublicId, "spots.json", key, "", h),
        (h?: Record<string, string>) => getPackage(f.areaPublicId, key, h),
        (h?: Record<string, string>) => getAreas(key, h),
      ]) {
        const first = await call();
        const etag = first.headers.get("etag")!;
        expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
        const again = await call({ "if-none-match": `"0000", W/${etag}` });
        expect(again.status).toBe(304);
        expect(await again.text()).toBe("");
        expect(again.headers.get("etag")).toBe(etag);
        expect((await call({ "if-none-match": '"0000"' })).status).toBe(200);
      }
    }));

  it("Cache-Control is private, max-age=60", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      for (const res of [
        await getAreas(key),
        await getPackage(f.areaPublicId, key),
        await getFile(f.areaPublicId, "coast.geojson", key),
        await getSchema("1.0", "spots.schema.json", key),
      ]) {
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("private, max-age=60");
      }
      // errors are never cached
      expect((await getFile(f.areaPublicId, "secrets.json", key)).headers.get("cache-control")).toBe("no-store");
    }));

  it("a rejected package is never served", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const { f, key } = await setup(tx, archive);
      await copySummaryOfA(tx, f);
      expect(await build(tx, archive, f)).toMatchObject({ status: "rejected", dataVersion: null });
      expect(archive.keys().some((k) => k.includes("/rejected/"))).toBe(true);
      expect((await getPackage(f.areaPublicId, key)).status).toBe(404);
      expect((await getFile(f.areaPublicId, "spots.json", key)).status).toBe(404);
      expect((await getFile(f.areaPublicId, "spots.json", key, "?dataVersion=1")).status).toBe(404);
      const listed = (await (await getAreas(key)).json()) as { areas: Array<{ id: string; dataVersion: number | null }> };
      expect(listed.areas.find((a) => a.id === f.areaPublicId)?.dataVersion).toBeNull();
    }));

  it("a rejected build after a valid one leaves the valid package current", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      await copySummaryOfA(tx, f);
      expect(await build(tx, archive, f, LATER)).toMatchObject({ status: "rejected" });
      const res = await getPackage(f.areaPublicId, key);
      expect(res.headers.get("periplus-data-version")).toBe("1");
      expect((await getFile(f.areaPublicId, "manifest.json", key, "?dataVersion=2")).status).toBe(404);
    }));
});

describe("GET /api/v1/schema/[version]/[file]", () => {
  it("the schema endpoint returns the checked-in JSON schema", () =>
    withRollback(async (tx) => {
      db = tx;
      const { key } = await reader(tx);
      for (const file of ["spots.schema.json", "manifest.schema.json", "coast.schema.json", "changes.schema.json"]) {
        const res = await getSchema("1.0", file, key);
        expect(res.status, file).toBe(200);
        expect(await res.text()).toBe(readFileSync(`contract/schema/1.0/${file}`, "utf8"));
        expect(res.headers.get("periplus-schema-version")).toBe("1.0");
        expect(res.headers.has("periplus-data-version")).toBe(false);
      }
      for (const [version, file] of [
        ["2.0", "spots.schema.json"],
        ["1.0", "secrets.schema.json"],
        ["1.0", "spots.json"],
        ["1.0", "../spots.schema.json"],
      ] as const) {
        const res = await getSchema(version, file, key);
        expect(res.status, `${version}/${file}`).toBe(404);
        expect((await res.json()).error.code).toBe("not_found");
      }
    }));
});
