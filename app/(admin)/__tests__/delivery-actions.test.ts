import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import type { PgBoss } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { geoNames, runs } from "@/lib/db/schema";
import { authenticateApiClient, createApiClient, listApiClients } from "@/lib/domain/api-clients";
import { setDeliveryArchive } from "@/lib/domain/delivery/archive";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { newId } from "@/lib/domain/ids";
import { DELIVERY_STAGE } from "@/lib/pipeline/delivery";
import { testDb, withRollback } from "@/test/db";
import { seedImage } from "@/test/fixtures/delivery/images";
import { seedDeliverySubdivision } from "@/test/fixtures/delivery/subdivision";
import { memoryArchive } from "@/test/s3";

/*
 * The admin's delivery actions (plan Task 13): „Paket bauen“, the file download (a rejected package's too) and
 * „Sperren“ of an API client, against the rolled-back test transaction; the session, the queue and the navigation are
 * stubs.
 */

let currentDb: Db = testDb();
const requireAdmin = vi.fn();
const adminSession = vi.fn();
const redirect = vi.fn();
const inserted: Array<{ queue: string; data: Record<string, unknown> }> = [];
const boss = {
  insert: async (queue: string, jobs: Array<{ id: string; data: Record<string, unknown> }>) => {
    inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
    return jobs.map((j) => j.id);
  },
} as unknown as PgBoss;

vi.mock("@/lib/security/require-admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/require-admin")>()),
  requireAdmin: () => requireAdmin(),
  adminSession: () => adminSession(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => currentDb,
}));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => boss }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

const { buildDeliveryAction } = await import("../deliveries/actions");
const { revokeApiClientAction } = await import("../settings/actions");
const { GET: download } = await import("../deliveries/[id]/files/[file]/route");
const { GET: downloadImage } = await import("../deliveries/[id]/files/images/[file]/route");

const ADMIN = `${newId()}@test.invalid`;

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};
const getFile = (id: string, file: string) =>
  download(new NextRequest(`http://localhost/deliveries/${id}/files/${file}`), { params: Promise.resolve({ id, file }) });

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  currentDb = testDb();
  requireAdmin.mockResolvedValue({ email: ADMIN });
  adminSession.mockResolvedValue({ sub: newId(), email: ADMIN });
});
afterEach(() => setDeliveryArchive(null));

describe("buildDeliveryAction", () => {
  it("buildDeliveryAction starts a delivery run for the subdivision", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const f = await seedDeliverySubdivision(tx);
      await buildDeliveryAction(form({ subdivisionKey: f.subdivisionKey }));
      const [run] = await tx.select().from(runs).where(eq(runs.triggeredBy, ADMIN));
      expect(run).toMatchObject({
        kind: "stage",
        scopeType: "subdivision",
        scopeId: f.subdivisionKey,
        stages: [DELIVERY_STAGE],
        params: { subdivisionId: f.subdivisionId, subdivisionKey: f.subdivisionKey },
      });
      expect(inserted).toEqual([{ queue: "delivery.build", data: expect.objectContaining({ subdivisionId: f.subdivisionId, runId: run!.id }) }]);
      expect(redirect).toHaveBeenCalledWith(`/runs/${run!.id}`);
    }));

  it("buildDeliveryAction rejects an unknown key and an area key without starting a run", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      await seedDeliverySubdivision(tx);
      await expect(buildDeliveryAction({ subdivisionKey: "XT-UNKNOWN" })).rejects.toThrow("Unbekannter Landesteil XT-UNKNOWN");
      await expect(buildDeliveryAction({ subdivisionKey: "saronic" })).rejects.toThrow(/Landesteil angeben/);
      await expect(buildDeliveryAction({ subdivisionKey: "" })).rejects.toThrow();
      expect(await tx.select().from(runs).where(eq(runs.triggeredBy, ADMIN))).toEqual([]);
      expect(inserted).toEqual([]);
    }));

  it("needs an admin session", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(buildDeliveryAction({ subdivisionKey: "XT-DELIVERY" })).rejects.toThrow("NEXT_REDIRECT");
    await expect(revokeApiClientAction({ id: newId() })).rejects.toThrow("NEXT_REDIRECT");
    expect(inserted).toEqual([]);
  });
});

describe("GET /deliveries/[id]/files/[file]", () => {
  it("the download route needs a session and serves a rejected package's file", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const archive = memoryArchive();
      setDeliveryArchive(archive);
      const f = await seedDeliverySubdivision(tx);
      // A has a second name that is a domain: the package is rejected (a copied fact would only be dropped)
      await tx.insert(geoNames).values({ geoObjectId: f.places.A.geoObjectId, name: "sailing-guide.example.com", nameNormalized: "sailing-guide.example.com", language: "en", script: "latin", origin: "osm" });
      const rejected = await buildDelivery(tx, archive, f.subdivisionId, { now: new Date("2040-06-01T08:00:00Z"), inCallerTransaction: true });
      expect(rejected.status).toBe("rejected");

      adminSession.mockResolvedValue(null);
      const denied = await getFile(rejected.deliveryId, "spots.json");
      expect(denied.status).toBe(401);
      expect(await denied.text()).not.toContain(f.places.A.publicId!);

      adminSession.mockResolvedValue({ sub: newId(), email: ADMIN });
      const res = await getFile(rejected.deliveryId, "spots.json");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${f.subdivisionPublicId}-rejected-spots.json"`);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(await archive.get(`deliveries/${f.subdivisionKey}/rejected/${rejected.deliveryId}/spots.json`));
      const coast = await getFile(rejected.deliveryId, "coast.geojson");
      expect(coast.headers.get("content-type")).toBe("application/geo+json");

      // unknown delivery, a file it does not have, a name that is no contract file, an id that is no uuid
      for (const [id, file] of [[newId(), "spots.json"], [rejected.deliveryId, "changes.json"], [rejected.deliveryId, "secrets.json"], ["x", "spots.json"]] as const) {
        const missing = await getFile(id, file);
        expect(missing.status, `${id}/${file}`).toBe(404);
        expect(missing.headers.get("cache-control")).toBe("private, no-store");
      }
    }));
});

describe("GET /deliveries/[id]/files/images/[file]", () => {
  it("serves a package image to a session only, and refuses unlisted or malformed names", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const archive = memoryArchive();
      setDeliveryArchive(archive);
      const f = await seedDeliverySubdivision(tx);
      await seedImage(tx, f, archive, { content: "jpeg bytes" });
      const built = await buildDelivery(tx, archive, f.subdivisionId, { now: new Date("2040-06-01T08:00:00Z"), inCallerTransaction: true });
      expect(built.status).toBe("valid");
      const name = `${f.places.A.publicId}-title.jpg`;
      const get = (id: string, file: string) =>
        downloadImage(new NextRequest(`http://localhost/deliveries/${id}/files/images/${file}`), { params: Promise.resolve({ id, file }) });

      adminSession.mockResolvedValue(null);
      expect((await get(built.deliveryId, name)).status).toBe(401);

      adminSession.mockResolvedValue({ sub: newId(), email: ADMIN });
      const res = await get(built.deliveryId, name);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${f.subdivisionPublicId}-1-images-${name}"`);
      expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))).toBe("jpeg bytes");
      for (const [id, file] of [[newId(), name], [built.deliveryId, "sp_01J9ZD00000000000000000002-title.jpg"], [built.deliveryId, "secrets.jpg"], ["x", name]] as const) {
        expect((await get(id, file)).status, `${id}/${file}`).toBe(404);
      }
    }));
});

describe("revokeApiClientAction", () => {
  it("revoking an api client makes its key fail", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const { id, key } = await createApiClient(tx, { name: `test-${newId()}`, scopes: ["delivery:read"] });
      expect((await listApiClients(tx)).find((c) => c.id === id)).toMatchObject({ revokedAt: null, scopes: ["delivery:read"] });
      await revokeApiClientAction(form({ id }));
      expect(redirect).toHaveBeenCalledWith("/settings?notice=api_client_revoked#api-clients");
      expect((await listApiClients(tx)).find((c) => c.id === id)!.revokedAt).toBeInstanceOf(Date);
      expect(await authenticateApiClient(tx, `Bearer ${key}`)).toBeNull();
      await expect(revokeApiClientAction({ id: "not-a-uuid" })).rejects.toThrow();
    }));
});
