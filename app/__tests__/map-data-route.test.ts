import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { createUser } from "@/lib/domain/users";
import { createSessionToken, SESSION_COOKIE } from "@/lib/security/session";
import { testDb, withRollback } from "@/test/db";

let db: Db = testDb();
let token: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && token ? { value: token } : undefined) }),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));
vi.mock("@/lib/db/client", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/db/client")>()),
  getDb: () => db,
}));

const { GET } = await import("../(admin)/map-data/[layer]/route");

// Outside the pilot box 23.0-23.75 E x 37.0-38.0 N, at a spot no other test uses.
const LON = 27.37;
const LAT = 33.37;

const call = (layer: string, bbox: string) =>
  GET(new NextRequest(`http://localhost/map-data/${layer}?bbox=${bbox}`), { params: Promise.resolve({ layer }) });

async function login(tx: Db): Promise<void> {
  const email = `${newId()}@test.invalid`;
  const { id } = await createUser(tx, email, "correct horse battery");
  token = await createSessionToken({ id, email });
}

beforeEach(() => {
  token = undefined;
  db = testDb();
});

describe("GET /map-data/[layer]", () => {
  it("401 without a session, never data", async () => {
    const res = await call("places", `${LON - 0.1},${LAT - 0.1},${LON + 0.1},${LAT + 0.1}`);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: "unauthorized" } });
  });

  it("400 for an unknown layer or a bbox larger than 5°", () =>
    withRollback(async (tx) => {
      db = tx;
      await login(tx);
      for (const [layer, bbox] of [
        ["routes", "27,33,28,34"],
        ["places", "20,33,25.1,34"],
        ["places", "27,30,28,35.5"],
        ["places", "28,33,27,34"],
        ["places", "27,33,28"],
        ["places", "a,33,28,34"],
        ["places", "27,-91,28,-89"],
      ]) {
        const res = await call(layer!, bbox!);
        expect(res.status, `${layer} ${bbox}`).toBe(400);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
      const missing = await GET(new NextRequest("http://localhost/map-data/places"), {
        params: Promise.resolve({ layer: "places" }),
      });
      expect(missing.status).toBe(400);
    }));

  it("200 geo+json for a valid request", () =>
    withRollback(async (tx) => {
      db = tx;
      await login(tx);
      const geom = sql`${geomFromGeoJson({ type: "Point", coordinates: [LON, LAT] })}`;
      const [object] = await tx.insert(geoObjects).values({ type: "bay", origin: "manual", geom }).returning({ id: geoObjects.id });
      const [place] = await tx
        .insert(places)
        .values({ geoObjectId: object!.id, kind: "anchorage", status: "confirmed", position: geom })
        .returning({ id: places.id });

      const res = await call("places", `${LON - 0.1},${LAT - 0.1},${LON + 0.1},${LAT + 0.1}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/geo+json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as GeoJSON.FeatureCollection;
      expect(body.type).toBe("FeatureCollection");
      expect(body.features.map((f) => f.properties!.id)).toEqual([place!.id]);
    }));
});
