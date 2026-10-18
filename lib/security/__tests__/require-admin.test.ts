import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/db";
import { newId } from "@/lib/domain/ids";
import { createUser, disableUser } from "@/lib/domain/users";
import { createSessionToken, SESSION_COOKIE } from "../session";

const db = testDb();
let token: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && token ? { value: token } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/db/client", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/db/client")>()),
  getDb: () => db,
}));

const { requireAdmin } = await import("../require-admin");

beforeEach(() => {
  token = undefined;
});

describe("requireAdmin", () => {
  it("redirects to /login without a session", async () => {
    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("returns the claims for an active user", async () => {
    const email = `${newId()}@test.invalid`;
    const { id } = await createUser(db, email, "correct horse battery");
    token = await createSessionToken({ id, email });
    await expect(requireAdmin()).resolves.toMatchObject({ sub: id, email });
  });

  it("disabled user is rejected by requireAdmin", async () => {
    const email = `${newId()}@test.invalid`;
    const { id } = await createUser(db, email, "correct horse battery");
    token = await createSessionToken({ id, email });
    await disableUser(db, email);
    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT:/login");
  });
});
