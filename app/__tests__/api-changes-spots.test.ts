import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changesResponseSchema, type Spot, type SpotsFile } from "@/contract";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { places, subdivisions } from "@/lib/db/schema";
import { createApiClient, revokeApiClient } from "@/lib/domain/api-clients";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { setDeliveryArchive } from "@/lib/domain/delivery/read";
import { newId } from "@/lib/domain/ids";
import { testDb, withRollback } from "@/test/db";
import { changeBerthCore, seedDeliverySubdivision, type DeliveryFixture } from "@/test/fixtures/delivery/subdivision";
import { memoryArchive } from "@/test/s3";

/*
 * The change route (contract 4.0: always `invalidSince`) and a spot as of a date (plan Task 12), called directly with the test
 * transaction as database (ruling M6-P21) and packages built by `buildDelivery` on the fixture subdivision. Build dates lie in
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

const changesRoute = await import("../api/v4/subdivisions/[subdivision]/changes/route");
const spotsRoute = await import("../api/v4/spots/[id]/route");

const BASE = "http://localhost/api/v4";
const day = (d: string) => new Date(`${d}T08:00:00Z`);

const request = (path: string, key: string | undefined, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });
const getChanges = (subdivision: string, key: string | undefined, query: string, headers?: Record<string, string>) =>
  changesRoute.GET(request(`/subdivisions/${subdivision}/changes${query}`, key, headers), { params: Promise.resolve({ subdivision }) });
const getSpot = (id: string, key: string | undefined, query = "", headers?: Record<string, string>) =>
  spotsRoute.GET(request(`/spots/${id}${query}`, key, headers), { params: Promise.resolve({ id }) });

const build = (tx: Db, archive: Archive, f: DeliveryFixture, date: string) =>
  buildDelivery(tx, archive, f.subdivisionId, { now: day(date), inCallerTransaction: true });

async function setup(tx: Db) {
  db = tx;
  const archive = memoryArchive();
  setDeliveryArchive(archive);
  const f = await seedDeliverySubdivision(tx);
  const { key } = await createApiClient(tx, { name: `test-${newId()}`, scopes: ["delivery:read"] });
  return { f, archive, key };
}

/** A's berth state rewritten with `patch` of its core values (a new state date). */
const changeA = (tx: Db, f: DeliveryFixture, patch: Record<string, unknown>) => changeBerthCore(tx, f.places.A.placeId, patch, new Date("2026-10-23T08:00:00Z"));

const spotOf = async (archive: Archive, f: DeliveryFixture, v: number, id: string) =>
  (JSON.parse(new TextDecoder().decode((await archive.get(`deliveries/${f.subdivisionKey}/${v}/spots.json`))!)) as SpotsFile).spots.find((s) => s.id === id)!;

beforeEach(() => {
  db = testDb();
});
afterEach(() => setDeliveryArchive(null));

describe("changes and spots: authentication", () => {
  it("401 without key, 401 with a revoked key, 403 with reports:write only", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      const writer = await createApiClient(tx, { name: `test-${newId()}`, scopes: ["reports:write"] });
      const revoked = await createApiClient(tx, { name: `test-${newId()}`, scopes: ["delivery:read"] });
      await revokeApiClient(tx, revoked.id);
      const calls = [
        (k?: string) => getChanges(f.subdivisionPublicId, k, "?since=1"),
        (k?: string) => getSpot(f.places.A.publicId!, k),
        // parameters are checked only after the key: a bad one never answers 400 to a caller without access
        (k?: string) => getChanges(f.subdivisionPublicId, k, "?since=abc"),
        (k?: string) => getSpot(f.places.A.publicId!, k, "?asOf=gestern"),
      ];
      for (const call of calls) {
        const none = await call();
        expect(none.status).toBe(401);
        expect(none.headers.get("www-authenticate")).toBe("Bearer");
        const gone = await call(revoked.key);
        expect(gone.status).toBe(401);
        expect(await gone.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid API key." } });
        const forbidden = await call(writer.key);
        expect(forbidden.status).toBe(403);
        expect(await forbidden.json()).toEqual({ error: { code: "forbidden", message: "The API key lacks the required scope." } });
      }
      expect((await calls[0]!(key)).status).toBe(200);
      expect((await calls[1]!(key)).status).toBe(200);
    }));
});

describe("GET /api/v4/subdivisions/[subdivision]/changes", () => {
  it("answers 200 invalidSince reload whatever `since` (there is no change feed in 4.0)", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      for (const query of ["?since=1", "?since=0", "", "?since=abc", "?since=99999999999"]) {
        const res = await getChanges(f.subdivisionPublicId, key, query);
        expect(res.status, query).toBe(200);
        expect(res.headers.get("periplus-schema-version")).toBe("4.0");
        const body = await res.json();
        expect(body, query).toEqual({ invalidSince: true, reason: "reload" });
        expect(changesResponseSchema.safeParse(body).success).toBe(true);
      }
    }));
});

describe("GET /api/v4/spots/[id]", () => {
  it("asOf returns the spot version delivered on that date", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      await changeA(tx, f, { "shelter.E": 0.8 });
      await build(tx, archive, f, "2040-06-15");
      const a = f.places.A.publicId!;
      const asOf = async (query: string) => {
        const res = await getSpot(a, key, query);
        expect(res.status, query).toBe(200);
        return { header: res.headers.get("periplus-data-version"), body: (await res.json()) as { schemaVersion: string; subdivision: string; dataVersion: number; spot: Spot } };
      };
      const early = await asOf("?asOf=2040-06-10");
      expect(early.body).toEqual({ schemaVersion: "4.0", subdivision: f.subdivisionPublicId, dataVersion: 1, spot: await spotOf(archive, f, 1, a) });
      expect(early.body.spot).toMatchObject({ asOf: "2026-10-20" });
      expect(early.header).toBe("1");
      expect((await asOf("?asOf=2040-06-01")).body.spot.asOf).toBe("2026-10-20");
      expect((await asOf("?asOf=2040-06-15")).body).toEqual({ schemaVersion: "4.0", subdivision: f.subdivisionPublicId, dataVersion: 2, spot: await spotOf(archive, f, 2, a) });
      expect((await asOf("")).body).toMatchObject({ dataVersion: 2, spot: { asOf: "2026-10-23" } });
      // an unchanged spot keeps the content of the delivery that introduced its version
      expect((await (await getSpot(f.places.M.publicId!, key)).json()) as { dataVersion: number }).toMatchObject({ dataVersion: 1, spot: { asOf: "2026-10-19" } });
    }));

  it("asOf before the first delivery is 404", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      expect((await getSpot(f.places.A.publicId!, key)).status).toBe(404);
      await build(tx, archive, f, "2040-06-01");
      const res = await getSpot(f.places.A.publicId!, key, "?asOf=2040-05-31");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found." } });
      // a place that is never delivered (incomplete shelter) and an id nobody has
      expect((await getSpot(f.places.B.publicId!, key)).status).toBe(404);
      expect((await getSpot("sp_01J9ZD00000000000000000999", key)).status).toBe(404);
    }));

  it("an invalid date is 400, an id that is no spot id is 404", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      for (const date of ["2026-13-45", "2026-02-30", "gestern", "", "2040-6-1", "2040-06-01T00:00:00Z", "20400601"]) {
        const res = await getSpot(f.places.A.publicId!, key, `?asOf=${encodeURIComponent(date)}`);
        expect(res.status, date).toBe(400);
        expect((await res.json()).error.code, date).toBe("invalid_date");
      }
      expect((await getSpot(f.places.A.publicId!, key, "?asOf=2040-02-29")).status).toBe(404);
      for (const id of [f.poiPublicId, f.subdivisionPublicId, "sp_123", f.places.A.publicId!.toLowerCase(), "..", "sp_01J9ZD0000000000000000000L"]) {
        const res = await getSpot(id, key);
        expect(res.status, id).toBe(404);
        expect((await res.json()).error.code).toBe("not_found");
      }
    }));

  it("a removed spot is 404 after removal and found before", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      // B is not delivered: A merged into it is removed from the package
      await tx.update(places).set({ mergedIntoId: f.places.B.placeId }).where(eq(places.id, f.places.A.placeId));
      expect(await build(tx, archive, f, "2040-06-15")).toMatchObject({ dataVersion: 2 });
      const a = f.places.A.publicId!;
      expect((await getSpot(a, key, "?asOf=2040-06-10")).status).toBe(200);
      expect((await getSpot(a, key, "?asOf=2040-06-15")).status).toBe(404);
      expect((await getSpot(a, key)).status).toBe(404);
    }));

  it("a spot only a subdivision that has ended delivered is 404", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      expect((await getSpot(f.places.A.publicId!, key)).status).toBe(200);
      await tx.update(subdivisions).set({ validTo: sql`current_date` }).where(eq(subdivisions.id, f.subdivisionId));
      expect((await getSpot(f.places.A.publicId!, key)).status).toBe(404);
      expect((await getSpot(f.places.A.publicId!, key, "?asOf=2040-06-10")).status).toBe(404);
    }));

  it("responses carry ETag and Periplus-Schema-Version 4.0", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      for (const call of [
        (h?: Record<string, string>) => getSpot(f.places.A.publicId!, key, "", h),
        (h?: Record<string, string>) => getChanges(f.subdivisionPublicId, key, "?since=1", h),
      ]) {
        const res = await call();
        expect(res.status).toBe(200);
        expect(res.headers.get("periplus-schema-version")).toBe("4.0");
        if (res.headers.has("periplus-data-version")) expect(res.headers.get("periplus-data-version")).toBe("1");
        expect(res.headers.get("cache-control")).toBe("private, max-age=60");
        expect(res.headers.get("vary")).toBe("Authorization");
        const etag = res.headers.get("etag")!;
        expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
        expect((await call({ "if-none-match": etag })).status).toBe(304);
      }
    }));
});
