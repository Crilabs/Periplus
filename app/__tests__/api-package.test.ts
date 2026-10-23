import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Manifest, SpotsFile } from "@/contract";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { deliveries, profileSummaries, textShingles } from "@/lib/db/schema";
import { createApiClient, revokeApiClient } from "@/lib/domain/api-clients";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { setDeliveryArchive } from "@/lib/domain/delivery/read";
import { sha256Hex } from "@/lib/domain/delivery/serialize";
import { shingleHashes } from "@/lib/domain/documents/shingles";
import { newId } from "@/lib/domain/ids";
import { decideAccess } from "@/lib/security/access";
import { seedImage } from "@/test/fixtures/delivery/images";
import { insertProfile, provenanceEntry } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";
import { seedDeliverySubdivision, SPOT_A_ATTRIBUTES, spotAProvenance, type DeliveryFixture } from "@/test/fixtures/delivery/subdivision";
import { deleteTestObjects, memoryArchive, testArchive } from "@/test/s3";
import { insertTestVersion } from "@/test/text";

/*
 * The delivery API's subdivision, package, file and schema endpoints (plan Task 11, contract 3.0 under `/api/v3`),
 * called directly with the test transaction as database (ruling M6-P21) and packages built by `buildDelivery` on the
 * fixture subdivision. Build dates lie in
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

const subdivisionsRoute = await import("../api/v3/subdivisions/route");
const packageRoute = await import("../api/v3/subdivisions/[subdivision]/package/route");
const fileRoute = await import("../api/v3/subdivisions/[subdivision]/package/[file]/route");
const imageRoute = await import("../api/v3/subdivisions/[subdivision]/package/images/[file]/route");
const schemaRoute = await import("../api/v3/schema/[version]/[file]/route");
const schemaRouteV1 = await import("../api/v1/schema/[version]/[file]/route");

const NOW = new Date("2040-06-01T08:00:00Z");
const LATER = new Date("2040-06-02T08:00:00Z");
const BASE = "http://localhost/api/v3";

const request = (path: string, key?: string, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });
const getSubdivisions = (key?: string, headers?: Record<string, string>) => subdivisionsRoute.GET(request("/subdivisions", key, headers));
const getPackage = (subdivision: string, key?: string, headers?: Record<string, string>) =>
  packageRoute.GET(request(`/subdivisions/${subdivision}/package`, key, headers), { params: Promise.resolve({ subdivision }) });
const getFile = (subdivision: string, file: string, key?: string, query = "", headers?: Record<string, string>) =>
  fileRoute.GET(request(`/subdivisions/${subdivision}/package/${encodeURIComponent(file)}${query}`, key, headers), {
    params: Promise.resolve({ subdivision, file }),
  });
const getImage = (subdivision: string, file: string, key?: string, query = "", headers?: Record<string, string>) =>
  imageRoute.GET(request(`/subdivisions/${subdivision}/package/images/${encodeURIComponent(file)}${query}`, key, headers), {
    params: Promise.resolve({ subdivision, file }),
  });
const getSchema = (version: string, file: string, key?: string) =>
  schemaRoute.GET(request(`/schema/${version}/${file}`, key), { params: Promise.resolve({ version, file }) });

const reader = (tx: Db) => createApiClient(tx, { name: `test-${newId()}`, scopes: ["delivery:read"] });
const build = (tx: Db, archive: Archive, f: DeliveryFixture, now = NOW) =>
  buildDelivery(tx, archive, f.subdivisionId, { now, inCallerTransaction: true });

/** The test transaction as database, an in-memory archive behind the API, the fixture subdivision and a reader key. */
async function setup(tx: Db, archive: Archive = memoryArchive()) {
  db = tx;
  setDeliveryArchive(archive);
  const f = await seedDeliverySubdivision(tx);
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
    const res = await getSubdivisions();
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
        (k?: string) => getSubdivisions(k),
        (k?: string) => getPackage(f.subdivisionPublicId, k),
        (k?: string) => getFile(f.subdivisionPublicId, "spots.json", k),
        (k?: string) => getSchema("2.0", "spots.schema.json", k),
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

describe("GET /api/v3/subdivisions", () => {
  it("lists the subdivision with the data version, bbox and build time of its latest valid package", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      const before = await getSubdivisions(key);
      expect(before.status).toBe(200);
      const listed = (await before.json()) as { schemaVersion: string; subdivisions: Array<{ id: string }> };
      expect(listed.schemaVersion).toBe("3.0");
      expect(listed.subdivisions.find((s) => s.id === f.subdivisionPublicId)).toEqual({
        id: f.subdivisionPublicId,
        key: f.subdivisionKey,
        name: "Testlandesteil",
        country: "GR",
        dataVersion: null,
        bbox: null,
        generatedAt: null,
      });

      await build(tx, archive, f);
      const manifest = JSON.parse(new TextDecoder().decode((await archive.get(`deliveries/${f.subdivisionKey}/1/manifest.json`))!)) as Manifest;
      const res = await getSubdivisions(key);
      expect(res.headers.has("periplus-data-version")).toBe(false);
      const body = (await res.json()) as { subdivisions: Array<{ id: string }> };
      expect(body.subdivisions.find((s) => s.id === f.subdivisionPublicId)).toEqual({
        id: f.subdivisionPublicId,
        key: f.subdivisionKey,
        name: "Testlandesteil",
        country: "GR",
        dataVersion: 1,
        bbox: manifest.bbox,
        generatedAt: NOW.toISOString(),
      });
    }));

  it("lists from the delivery rows alone: a package missing in S3 does not fail the list", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      const [row] = await tx.select({ bbox: deliveries.bbox }).from(deliveries).where(eq(deliveries.subdivisionId, f.subdivisionId));
      expect(row!.bbox).toEqual(f.bbox);
      // an archive that has lost every file and fails every read
      const broken: Archive = { ...memoryArchive(), get: async () => Promise.reject(new Error("S3 unreachable")) };
      setDeliveryArchive(broken);
      const res = await getSubdivisions(key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { subdivisions: Array<{ id: string; bbox: number[] | null; dataVersion: number | null }> };
      expect(body.subdivisions.find((s) => s.id === f.subdivisionPublicId)).toMatchObject({ dataVersion: 1, bbox: f.bbox });
      // the package itself fails closed
      expect((await getPackage(f.subdivisionPublicId, key)).status).toBe(500);
    }));
});

describe("GET /api/v3/subdivisions/[subdivision]/package", () => {
  it("the package manifest links every file of the current data version", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      await changeA(tx, f);
      expect(await build(tx, archive, f, LATER)).toMatchObject({ status: "valid", dataVersion: 2 });

      // by public id and by key
      for (const ref of [f.subdivisionPublicId, f.subdivisionKey]) {
        const res = await getPackage(ref, key);
        expect(res.status, ref).toBe(200);
        expect(res.headers.get("periplus-data-version")).toBe("2");
        const body = (await res.json()) as Manifest & { links: Record<string, string> };
        const stored = JSON.parse(new TextDecoder().decode((await archive.get(`deliveries/${f.subdivisionKey}/2/manifest.json`))!)) as Manifest;
        const { links, ...manifest } = body;
        expect(manifest).toEqual(stored);
        expect(links).toEqual(
          Object.fromEntries(
            ["manifest.json", "spots.json", "highlights.json", "regions.json", "coast.geojson", "weather-points.json", "changes.json"].map((file) => [
              file,
              `/api/v3/subdivisions/${f.subdivisionPublicId}/package/${file}?dataVersion=2`,
            ]),
          ),
        );
      }
    }));

  it("the first package has no changes.json link; an unknown subdivision or one without a package is 404", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      const none = await getPackage(f.subdivisionPublicId, key);
      expect(none.status).toBe(404);
      expect(await none.json()).toEqual({ error: { code: "not_found", message: "Not found." } });
      await build(tx, archive, f);
      const body = (await (await getPackage(f.subdivisionPublicId, key)).json()) as { links: Record<string, string> };
      expect(Object.keys(body.links)).not.toContain("changes.json");
      expect(Object.keys(body.links)).toHaveLength(6);
      expect((await getPackage("sd_01J9ZD00000000000000000999", key)).status).toBe(404);
      expect((await getPackage("XT-UNKNOWN", key)).status).toBe(404);
      // an island, a sailing area or its key is no subdivision
      for (const ref of [f.islandPublicId, f.areaPublicId, "xt-delivery-waters"]) expect((await getPackage(ref, key)).status, ref).toBe(404);
    }));

  it("a dataVersion on the package is 400: an older manifest is its file", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      for (const query of ["?dataVersion=1", "?dataVersion=", "?dataVersion=abc"]) {
        const res = await packageRoute.GET(request(`/subdivisions/${f.subdivisionPublicId}/package${query}`, key), {
          params: Promise.resolve({ subdivision: f.subdivisionPublicId }),
        });
        expect(res.status, query).toBe(400);
        expect(await res.json()).toEqual({ error: { code: "invalid_parameter", message: expect.stringContaining("manifest.json?dataVersion=") } });
      }
      expect((await getFile(f.subdivisionPublicId, "manifest.json", key, "?dataVersion=1")).status).toBe(200);
    }));

  it("a stored package of an older contract version is served with its own Periplus-Schema-Version", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      // deliveries are append-only; the test transaction plays a package stored before the contract moved to 3.0
      await tx.execute(sql`alter table deliveries disable trigger deliveries_append_only`);
      await tx.execute(sql`update deliveries set schema_version = '2.3'`);
      await tx.execute(sql`alter table deliveries enable trigger deliveries_append_only`);

      expect((await getPackage(f.subdivisionPublicId, key)).headers.get("periplus-schema-version")).toBe("2.3");
      expect((await getFile(f.subdivisionPublicId, "spots.json", key)).headers.get("periplus-schema-version")).toBe("2.3");
      expect((await getFile(f.subdivisionPublicId, "manifest.json", key, "?dataVersion=1")).headers.get("periplus-schema-version")).toBe("2.3");
      // the other endpoints speak the current contract
      expect((await getSubdivisions(key)).headers.get("periplus-schema-version")).toBe("3.0");
    }));
});

describe("GET /api/v3/subdivisions/[subdivision]/package/[file]", () => {
  it("a file is served byte-identical to the manifest hash with schema and data version headers", async () => {
    // the one S3 round trip: the files go to the test bucket and are deleted afterwards
    const archive = testArchive();
    await archive.ensureBucket();
    const keys: string[] = [];
    try {
      await withRollback(async (tx) => {
        const { f, key } = await setup(tx, archive);
        await build(tx, archive, f);
        const prefix = `deliveries/${f.subdivisionKey}/1/`;
        keys.push(...["manifest.json", "spots.json", "highlights.json", "regions.json", "coast.geojson", "weather-points.json"].map((n) => prefix + n));
        const manifest = (await (await getFile(f.subdivisionPublicId, "manifest.json", key)).json()) as Manifest;
        for (const entry of manifest.files) {
          const res = await getFile(f.subdivisionPublicId, entry.name, key);
          expect(res.status, entry.name).toBe(200);
          const bytes = new Uint8Array(await res.arrayBuffer());
          expect(sha256Hex(bytes), entry.name).toBe(entry.sha256);
          expect(bytes.byteLength).toBe(entry.bytes);
          expect(bytes).toEqual(await archive.get(prefix + entry.name));
          expect(res.headers.get("periplus-schema-version")).toBe("3.0");
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
        const res = await getFile(f.subdivisionPublicId, "spots.json", key, query);
        expect(res.status, query).toBe(200);
        return { version: res.headers.get("periplus-data-version"), a: ((await res.json()) as SpotsFile).spots.find((s) => s.id === f.places.A.publicId)! };
      };
      expect(await spotA("")).toMatchObject({ version: "2", a: { profileVersion: 2 } });
      expect(await spotA("?dataVersion=1")).toMatchObject({ version: "1", a: { profileVersion: 1, validFrom: "2040-06-01" } });
      const v1 = new Uint8Array(await (await getFile(f.subdivisionPublicId, "spots.json", key, "?dataVersion=1")).arrayBuffer());
      expect(v1).toEqual(await archive.get(`deliveries/${f.subdivisionKey}/1/spots.json`));
      // the first package has no change file
      expect((await getFile(f.subdivisionPublicId, "changes.json", key, "?dataVersion=1")).status).toBe(404);
      expect((await getFile(f.subdivisionPublicId, "changes.json", key, "?dataVersion=2")).status).toBe(200);

      for (const bad of ["0", "-1", "01", "1.0", "abc", "", "1e1"]) {
        const res = await getFile(f.subdivisionPublicId, "spots.json", key, `?dataVersion=${bad}`);
        expect(res.status, bad).toBe(400);
        expect(await res.json()).toEqual({ error: { code: "invalid_data_version", message: "dataVersion must be a positive integer." } });
      }
      for (const unknown of ["3", "99999999999"]) {
        const res = await getFile(f.subdivisionPublicId, "spots.json", key, `?dataVersion=${unknown}`);
        expect(res.status, unknown).toBe(404);
        expect((await res.json()).error.code).toBe("not_found");
      }
    }));

  it("unknown file and traversal are 404", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      // the proxy rejects an encoded separator before any route runs
      expect(decideAccess({ pathname: `/api/v3/subdivisions/${f.subdivisionPublicId}/package/..%2fspots.json`, session: null, hasBearer: true })).toEqual({
        action: "deny",
        status: 404,
      });
      expect(decideAccess({ pathname: `/api/v3/subdivisions/${f.subdivisionPublicId}/package/../spots.json`, session: null, hasBearer: true })).toEqual({
        action: "deny",
        status: 404,
      });
      expect(decideAccess({ pathname: `/api/v3/subdivisions/${f.subdivisionPublicId}/package/secrets.json`, session: null, hasBearer: true })).toEqual({
        action: "allow",
      });
      // the route serves contract files only
      for (const file of ["secrets.json", "../spots.json", "..%2fspots.json", "spots.json/", "SPOTS.JSON", "manifest"]) {
        const res = await getFile(f.subdivisionPublicId, file, key);
        expect(res.status, file).toBe(404);
        expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found." } });
      }
    }));

  it("If-None-Match returns 304", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      for (const call of [
        (h?: Record<string, string>) => getFile(f.subdivisionPublicId, "spots.json", key, "", h),
        (h?: Record<string, string>) => getPackage(f.subdivisionPublicId, key, h),
        (h?: Record<string, string>) => getSubdivisions(key, h),
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
        await getSubdivisions(key),
        await getPackage(f.subdivisionPublicId, key),
        await getFile(f.subdivisionPublicId, "coast.geojson", key),
        await getSchema("2.0", "spots.schema.json", key),
      ]) {
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("private, max-age=60");
        // the answer depends on the key: no private cache hands it to another one
        expect(res.headers.get("vary")).toBe("Authorization");
      }
      // errors are never cached
      const error = await getFile(f.subdivisionPublicId, "secrets.json", key);
      expect(error.headers.get("cache-control")).toBe("no-store");
      expect(error.headers.get("vary")).toBe("Authorization");
    }));

  it("a rejected package is never served", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const { f, key } = await setup(tx, archive);
      await copySummaryOfA(tx, f);
      expect(await build(tx, archive, f)).toMatchObject({ status: "rejected", dataVersion: null });
      expect(archive.keys().some((k) => k.includes("/rejected/"))).toBe(true);
      expect((await getPackage(f.subdivisionPublicId, key)).status).toBe(404);
      expect((await getFile(f.subdivisionPublicId, "spots.json", key)).status).toBe(404);
      expect((await getFile(f.subdivisionPublicId, "spots.json", key, "?dataVersion=1")).status).toBe(404);
      const listed = (await (await getSubdivisions(key)).json()) as { subdivisions: Array<{ id: string; dataVersion: number | null }> };
      expect(listed.subdivisions.find((s) => s.id === f.subdivisionPublicId)?.dataVersion).toBeNull();
    }));

  it("a rejected build after a valid one leaves the valid package current", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f);
      await copySummaryOfA(tx, f);
      expect(await build(tx, archive, f, LATER)).toMatchObject({ status: "rejected" });
      const res = await getPackage(f.subdivisionPublicId, key);
      expect(res.headers.get("periplus-data-version")).toBe("1");
      expect((await getFile(f.subdivisionPublicId, "manifest.json", key, "?dataVersion=2")).status).toBe(404);
    }));
});

describe("GET /api/v3/subdivisions/[subdivision]/package/images/[file]", () => {
  const JPG = "jpeg bytes of the title image";
  const bytes = new TextEncoder().encode(JPG);
  /** The title image of spot A in the built package. */
  let NAME = "";

  /** A package with the title image of A (sources Sentinel-2 and the DEM: delivered). */
  async function withImage(tx: Db, archive: Archive, f: DeliveryFixture) {
    await seedImage(tx, f, archive, { content: JPG });
    NAME = `${f.places.A.publicId}-title.jpg`;
    await build(tx, archive, f);
  }

  it("serves a listed package image as image/jpeg with the hash as ETag and the same caching as the files", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await withImage(tx, archive, f);
      const res = await getImage(f.subdivisionPublicId, NAME, key);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(res.headers.get("etag")).toBe(`"${sha256Hex(bytes).slice(0, 32)}"`);
      expect(res.headers.get("cache-control")).toBe("private, max-age=60");
      expect(res.headers.get("periplus-data-version")).toBe("1");
      const again = await getImage(f.subdivisionPublicId, NAME, key, "?dataVersion=1", { "if-none-match": res.headers.get("etag")! });
      expect(again.status).toBe(304);
    }));

  it("needs a key; an unlisted image, a malformed name and a traversal are 404", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await withImage(tx, archive, f);
      expect((await getImage(f.subdivisionPublicId, NAME)).status).toBe(401);
      for (const file of ["sp_01J9ZD00000000000000000002-title.jpg", "secrets.jpg", "../spots.json", "sp_01J9ZD00000000000000000001-title.png", "sp_01J9ZD00000000000000000001-view-0.jpg", "spots.json"]) {
        expect((await getImage(f.subdivisionPublicId, file, key)).status, file).toBe(404);
      }
      expect((await getImage(f.subdivisionPublicId, NAME, key, "?dataVersion=abc")).status).toBe(400);
      expect((await getImage(f.subdivisionPublicId, NAME, key, "?dataVersion=7")).status).toBe(404);
    }));

  it("the existing file URLs keep working and still refuse an image name", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await withImage(tx, archive, f);
      expect((await getFile(f.subdivisionPublicId, "spots.json", key)).status).toBe(200);
      expect((await getFile(f.subdivisionPublicId, `images/${NAME}`, key)).status).toBe(404);
    }));
});

describe("GET /api/v3/schema/[version]/[file]", () => {
  it("the schema endpoint returns the checked-in JSON schema of every published version; /api/v1 still serves 1.0", () =>
    withRollback(async (tx) => {
      db = tx;
      const { key } = await reader(tx);
      const v1 = (version: string, file: string) =>
        schemaRouteV1.GET(new Request(`http://localhost/api/v1/schema/${version}/${file}`, { headers: { authorization: `Bearer ${key}` } }), {
          params: Promise.resolve({ version, file }),
        });
      for (const file of ["spots.schema.json", "manifest.schema.json", "coast.schema.json", "changes.schema.json"]) {
        for (const [version, res] of [
          ["2.3", await getSchema("2.3", file, key)],
          ["2.2", await getSchema("2.2", file, key)],
          ["2.1", await getSchema("2.1", file, key)],
          ["2.0", await getSchema("2.0", file, key)],
          ["1.0", await getSchema("1.0", file, key)],
          ["1.0", await v1("1.0", file)],
        ] as const) {
          expect(res.status, `${version}/${file}`).toBe(200);
          expect(await res.text()).toBe(readFileSync(`contract/schema/${version}/${file}`, "utf8"));
          expect(res.headers.get("periplus-schema-version")).toBe(version);
          expect(res.headers.has("periplus-data-version")).toBe(false);
        }
      }
      for (const [version, file] of [
        ["4.0", "spots.schema.json"],
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
