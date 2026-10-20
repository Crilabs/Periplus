import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeEntry, ChangesFile, Spot, SpotsFile } from "@/contract";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { places, profileSummaries } from "@/lib/db/schema";
import { createApiClient } from "@/lib/domain/api-clients";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { mergeChanges } from "@/lib/domain/delivery/changes";
import { setDeliveryArchive } from "@/lib/domain/delivery/read";
import { newId } from "@/lib/domain/ids";
import { insertProfile, provenanceEntry } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";
import { seedDeliveryArea, SPOT_A_ATTRIBUTES, SPOT_A_SUMMARY, spotAProvenance, type DeliveryFixture } from "@/test/fixtures/delivery/area";
import { memoryArchive } from "@/test/s3";

/*
 * The change feed since a data version and a spot as of a date (plan Task 12), called directly with the test
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

const changesRoute = await import("../api/v1/areas/[area]/changes/route");
const spotsRoute = await import("../api/v1/spots/[id]/route");

const BASE = "http://localhost/api/v1";
const day = (d: string) => new Date(`${d}T08:00:00Z`);

const request = (path: string, key: string, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${key}`, ...headers } });
const getChanges = (area: string, key: string, query: string, headers?: Record<string, string>) =>
  changesRoute.GET(request(`/areas/${area}/changes${query}`, key, headers), { params: Promise.resolve({ area }) });
const getSpot = (id: string, key: string, query = "", headers?: Record<string, string>) =>
  spotsRoute.GET(request(`/spots/${id}${query}`, key, headers), { params: Promise.resolve({ id }) });

const build = (tx: Db, archive: Archive, f: DeliveryFixture, date: string) =>
  buildDelivery(tx, archive, f.areaId, { now: day(date), inCallerTransaction: true });

async function setup(tx: Db) {
  db = tx;
  const archive = memoryArchive();
  setDeliveryArchive(archive);
  const f = await seedDeliveryArea(tx);
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
  (JSON.parse(new TextDecoder().decode((await archive.get(`deliveries/${f.areaPublicId}/${v}/changes.json`))!)) as ChangesFile).changes;
const spotOf = async (archive: Archive, f: DeliveryFixture, v: number, id: string) =>
  (JSON.parse(new TextDecoder().decode((await archive.get(`deliveries/${f.areaPublicId}/${v}/spots.json`))!)) as SpotsFile).spots.find((s) => s.id === id)!;

beforeEach(() => {
  db = testDb();
});
afterEach(() => setDeliveryArchive(null));

describe("GET /api/v1/areas/[area]/changes", () => {
  it("changes since 1 merge the change files of versions 2 and 3", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      await changeA(tx, f, { "shelter.E": 0.8 });
      expect(await build(tx, archive, f, "2040-06-02")).toMatchObject({ dataVersion: 2 });
      await tx.update(places).set({ mergedIntoId: f.places.M.placeId }).where(eq(places.id, f.places.A.placeId));
      expect(await build(tx, archive, f, "2040-06-03")).toMatchObject({ dataVersion: 3 });

      const res = await getChanges(f.areaPublicId, key, "?since=1");
      expect(res.status).toBe(200);
      expect(res.headers.get("periplus-data-version")).toBe("3");
      const body = (await res.json()) as { schemaVersion: string; area: string; since: number; dataVersion: number; changes: ChangeEntry[] };
      expect(body).toMatchObject({ schemaVersion: "1.0", area: f.areaPublicId, since: 1, dataVersion: 3 });
      expect(body.changes).toEqual(mergeChanges([await changesOf(archive, f, 2), await changesOf(archive, f, 3)]));
      // A: updated (safety) in 2, merged in 3 → one entry, the last event, the highest severity, the last version
      expect(body.changes.find((c) => c.objectId === f.places.A.publicId!)).toMatchObject({ event: "merged", severity: "safety", profileVersion: 3, fields: [] });
      expect(body.changes.find((c) => c.objectId === f.poiPublicId)).toMatchObject({ event: "updated", fields: ["spotIds"] });

      // since 2 is exactly the change file of version 3; by config key alike
      const since2 = (await (await getChanges(f.areaKey, key, "?since=2")).json()) as { since: number; changes: ChangeEntry[] };
      expect(since2).toMatchObject({ since: 2 });
      expect(since2.changes).toEqual(await changesOf(archive, f, 3));
    }));

  it("since equal to the current version is empty, since 0 is 400", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      const current = await getChanges(f.areaPublicId, key, "?since=1");
      expect(current.status).toBe(200);
      expect(await current.json()).toEqual({ schemaVersion: "1.0", area: f.areaPublicId, since: 1, dataVersion: 1, changes: [] });
      for (const query of ["?since=0", "", "?since=", "?since=abc", "?since=1.5", "?since=-1", "?since=1e0"]) {
        const res = await getChanges(f.areaPublicId, key, query);
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
        const res = await getChanges(f.areaPublicId, key, query);
        expect(res.status, query).toBe(400);
        expect(await res.json()).toEqual({ error: { code: "invalid_since", message: expect.any(String) } });
      }
    }));

  it("an unknown area or one without a valid package is 404", () =>
    withRollback(async (tx) => {
      const { f, key } = await setup(tx);
      expect((await getChanges(f.areaPublicId, key, "?since=1")).status).toBe(404);
      expect((await getChanges("unknown-area", key, "?since=1")).status).toBe(404);
    }));
});

describe("GET /api/v1/spots/[id]", () => {
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
        return { header: res.headers.get("periplus-data-version"), body: (await res.json()) as { schemaVersion: string; dataVersion: number; spot: Spot } };
      };
      const early = await asOf("?asOf=2040-06-10");
      expect(early.body).toEqual({ schemaVersion: "1.0", dataVersion: 1, spot: await spotOf(archive, f, 1, a) });
      expect(early.body.spot).toMatchObject({ profileVersion: 1, validFrom: "2040-06-01" });
      expect(early.header).toBe("1");
      expect((await asOf("?asOf=2040-06-01")).body.spot.profileVersion).toBe(1);
      expect((await asOf("?asOf=2040-06-15")).body).toEqual({ schemaVersion: "1.0", dataVersion: 2, spot: await spotOf(archive, f, 2, a) });
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
      for (const id of [f.poiPublicId, f.areaPublicId, "sp_123", f.places.A.publicId!.toLowerCase(), "..", "sp_01J9ZD0000000000000000000L"]) {
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

  it("responses carry ETag and Periplus-Schema-Version 1.0", () =>
    withRollback(async (tx) => {
      const { f, archive, key } = await setup(tx);
      await build(tx, archive, f, "2040-06-01");
      for (const call of [
        (h?: Record<string, string>) => getSpot(f.places.A.publicId!, key, "", h),
        (h?: Record<string, string>) => getChanges(f.areaPublicId, key, "?since=1", h),
      ]) {
        const res = await call();
        expect(res.status).toBe(200);
        expect(res.headers.get("periplus-schema-version")).toBe("1.0");
        expect(res.headers.get("periplus-data-version")).toBe("1");
        expect(res.headers.get("cache-control")).toBe("private, max-age=60");
        const etag = res.headers.get("etag")!;
        expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
        expect((await call({ "if-none-match": etag })).status).toBe(304);
      }
    }));
});
