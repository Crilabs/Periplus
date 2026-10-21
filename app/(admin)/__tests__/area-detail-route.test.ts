import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/domain/ids";
import { testDb } from "@/test/db";

const adminSession = vi.fn();

vi.mock("@/lib/security/require-admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/require-admin")>()),
  adminSession: () => adminSession(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => testDb(),
}));

const { GET } = await import("../map/area-detail/[id]/route");
const call = (id: string) => GET(new NextRequest(`http://localhost/map/area-detail/${id}`), { params: Promise.resolve({ id }) } as never);

beforeEach(() => {
  vi.resetAllMocks();
  adminSession.mockResolvedValue({ sub: newId(), email: "admin@example.invalid" });
});

describe("GET /map/area-detail/[id]", () => {
  it("is 401 without a session", async () => {
    adminSession.mockResolvedValue(null);
    expect((await call(newId())).status).toBe(401);
  });

  it("is 404 for an unknown and for an invalid id", async () => {
    expect((await call(newId())).status).toBe(404);
    expect((await call("not-a-uuid")).status).toBe(404);
  });
});
