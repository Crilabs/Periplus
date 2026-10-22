import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeEntry, ChangesFile, Spot, SpotsFile } from "@/contract";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { places, profileSummaries, subdivisions } from "@/lib/db/schema";
import { createApiClient, revokeApiClient } from "@/lib/domain/api-clients";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { mergeChanges } from "@/lib/domain/delivery/changes";
import { setDeliveryArchive } from "@/lib/domain/delivery/read";
import { newId } from "@/lib/domain/ids";
import { insertProfile, provenanceEntry } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";
import { seedDeliverySubdivision, SPOT_A_ATTRIBUTES, SPOT_A_SUMMARY, spotAProvenance, type DeliveryFixture } from "@/test/fixtures/delivery/subdivision";
import { memoryArchive } from "@/test/s3";

/*
 * The change feed since a data version and a spot as of a date (plan Task 12), called directly with the test
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

const changesRoute = await import("../api/v2/subdivisions/[subdivision]/changes/route");
const spotsRoute = await import("../api/v2/spots/[id]/route");

const BASE = "http://localhost/api/v2";
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

/** A second profile version of A with `patch` applied (the summary carried over). */
async function changeA(tx: Db, f: DeliveryFixture, patch: Record<string, unknown>): Promise<void> {
  await insertProfile(
    tx,
    f.places.A.geoObjectId,
    { ...SPOT_A_ATTRIBUTES, anchor_position: { lon: 21.1301, lat: 35.1445 }, "place.position": { lon: f.positions.A[0], lat: f.positions.A[1] }, ...patch },
    { ...spotAProvenance(f.factId), "place.position": provenanceEntry("gazetteer", { confidence: 1 }) },
    { version: 2, sourcesCount: 3, documentsCount: 1, confidence: 0.72 },
  );
  await tx.insert(profileSummaries).values({ geoObjectId: f.places.A.geoObjectId, profileVersion: 2, text: SPOT_A_SUMMARY, status: "ok", attempts: 1, model: "test", promptVersion: 1 });
}

const changesOf = async (archive: Archive, f: DeliveryFixture, v: number) =>
  (JSON.parse(new TextDecoder().decode((await archive.get(`deliveries/${f.subdivisionKey}/${v}/changes.json`))!)) as ChangesFile).changes;
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

describe("GET /api/v2/subdivisions/[subdivision]/changes", () => {
  it("changes since 1 merge the change files of versions 2 and 3", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      await changeA(tx, f, { "shelter.E": 0.8 });
      expect(await build(tx, archive, f, "2040-06-02")).toMatchObject({ dataVersion: 2 });
      await tx.update(places).set({ mergedIntoId: f.places.M.placeId }).where(eq(places.id, f.places.A.placeId));
      expect(await build(tx, archive, f, "2040-06-03")).toMatchObject({ dataVersion: 3 });

      const res = await getChanges(f.subdivisionPublicId, key, "?since=1");
      expect(res.status).toBe(200);
      expect(res.headers.get("periplus-data-version")).toBe("3");
      const body = (await res.json()) as { schemaVersion: string; subdivision: string; since: number; dataVersion: number; changes: ChangeEntry[] };
      expect(body).toMatchObject({ schemaVersion: "2.3", subdivision: f.subdivisionPublicId, since: 1, dataVersion: 3 });
      expect(body.changes).toEqual(mergeChanges([await changesOf(archive, f, 2), await changesOf(archive, f, 3)]));
      // A: updated (safety) in 2, merged in 3 → one entry, the last event, the highest severity, the last version
      expect(body.changes.find((c) => c.objectId === f.places.A.publicId!)).toMatchObject({ event: "merged", severity: "safety", profileVersion: 3, fields: [] });
      expect(body.changes.find((c) => c.objectId === f.poiPublicId)).toMatchObject({ event: "updated", fields: ["spotIds"] });

      // since 2 is exactly the change file of version 3; by config key alike
      const since2 = (await (await getChanges(f.subdivisionKey, key, "?since=2")).json()) as { since: number; changes: ChangeEntry[] };
      expect(since2).toMatchObject({ since: 2 });
      expect(since2.changes).toEqual(await changesOf(archive, f, 3));
    }));

  it("since equal to the current version is empty, since 0 is 400", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      const current = await getChanges(f.subdivisionPublicId, key, "?since=1");
      expect(current.status).toBe(200);
      expect(await current.json()).toEqual({ schemaVersion: "2.3", subdivision: f.subdivisionPublicId, since: 1, dataVersion: 1, changes: [] });
      // the same parser as dataVersion: no sign, no leading zeros
      for (const query of ["?since=0", "", "?since=", "?since=abc", "?since=1.5", "?since=-1", "?since=1e0", "?since=01", "?since=+1"]) {
        const res = await getChanges(f.subdivisionPublicId, key, query);
        expect(res.status, query).toBe(400);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect((await res.json()).error.code, query).toBe("invalid_since");
      }
    }));

  it("since above the current version is 400", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      for (const query of ["?since=2", "?since=99999999999"]) {
        const res = await getChanges(f.subdivisionPublicId, key, query);
        expect(res.status, query).toBe(400);
        expect(await res.json()).toEqual({ error: { code: "invalid_since", message: expect.any(String) } });
      }
    }));

  it("an unknown subdivision, a sailing area or a subdivision without a valid package is 404", () =>
    withRollback(async (tx) => {
      const { f, key } = await setup(tx);
      expect((await getChanges(f.subdivisionPublicId, key, "?since=1")).status).toBe(404);
      expect((await getChanges("XT-UNKNOWN", key, "?since=1")).status).toBe(404);
      expect((await getChanges(f.subdivisionPublicId, key, "?since=1")).status).toBe(404);
    }));
});

describe("GET /api/v2/spots/[id]", () => {
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
      expect(early.body).toEqual({ schemaVersion: "2.3", subdivision: f.subdivisionPublicId, dataVersion: 1, spot: await spotOf(archive, f, 1, a) });
      expect(early.body.spot).toMatchObject({ profileVersion: 1, validFrom: "2040-06-01" });
      expect(early.header).toBe("1");
      expect((await asOf("?asOf=2040-06-01")).body.spot.profileVersion).toBe(1);
      expect((await asOf("?asOf=2040-06-15")).body).toEqual({ schemaVersion: "2.3", subdivision: f.subdivisionPublicId, dataVersion: 2, spot: await spotOf(archive, f, 2, a) });
      expect((await asOf("")).body).toMatchObject({ dataVersion: 2, spot: { profileVersion: 2, validFrom: "2040-06-15" } });
      // an unchanged spot keeps the content of the delivery that introduced its version
      expect((await (await getSpot(f.places.M.publicId!, key)).json()) as { dataVersion: number }).toMatchObject({ dataVersion: 1, spot: { profileVersion: 1 } });
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

  it("responses carry ETag and Periplus-Schema-Version 2.2", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      for (const call of [
        (h?: Record<string, string>) => getSpot(f.places.A.publicId!, key, "", h),
        (h?: Record<string, string>) => getChanges(f.subdivisionPublicId, key, "?since=1", h),
      ]) {
        const res = await call();
        expect(res.status).toBe(200);
        expect(res.headers.get("periplus-schema-version")).toBe("2.3");
        expect(res.headers.get("periplus-data-version")).toBe("1");
        expect(res.headers.get("cache-control")).toBe("private, max-age=60");
        expect(res.headers.get("vary")).toBe("Authorization");
        const etag = res.headers.get("etag")!;
        expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
        expect((await call({ "if-none-match": etag })).status).toBe(304);
      }
    }));
});
