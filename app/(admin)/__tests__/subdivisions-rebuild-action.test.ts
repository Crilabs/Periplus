import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";

/*
 * „Landesteile neu bilden“ on /subdivisions (N7, B3): starts the system run as the admin, optionally only for the
 * countries of „nur Länder“, and opens it; a refused start (no land polygons, unknown country) returns to the list with
 * its reason. The starter itself is tested in lib/pipeline/__tests__/subdivisions-build.test.ts.
 */

const requireAdmin = vi.fn();
const redirect = vi.fn();
const startSubdivisionsBuildRun = vi.fn();

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db/client")>()), getDb: () => ({ db: "test" }) }));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({ boss: "test" }) }));
vi.mock("@/lib/pipeline/subdivisions-run", () => ({ startSubdivisionsBuildRun: (...args: unknown[]) => startSubdivisionsBuildRun(...args) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import { rebuildSubdivisionsAction } from "../subdivisions/actions";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

beforeEach(() => {
  vi.resetAllMocks();
  requireAdmin.mockResolvedValue({ email: "admin@example.invalid" });
  startSubdivisionsBuildRun.mockResolvedValue({ id: "run-3" });
});

describe("rebuildSubdivisionsAction", () => {
  it("starts the run for all countries when „nur Länder“ is empty and opens it", async () => {
    await rebuildSubdivisionsAction(form({ countries: "" }));
    expect(startSubdivisionsBuildRun).toHaveBeenCalledWith({ db: "test" }, { boss: "test" }, "admin@example.invalid", {});
    expect(redirect).toHaveBeenCalledWith("/runs/run-3");
  });

  it("passes the countries of „nur Länder“, upper-cased, split at commas and spaces", async () => {
    await rebuildSubdivisionsAction(form({ countries: "ps, ly  GR" }));
    expect(startSubdivisionsBuildRun).toHaveBeenCalledWith({ db: "test" }, { boss: "test" }, "admin@example.invalid", { countries: ["PS", "LY", "GR"] });
  });

  it("returns a refused start to the list with its reason", async () => {
    startSubdivisionsBuildRun.mockRejectedValue(new RunScopeNotReady("land_missing", "no land"));
    await rebuildSubdivisionsAction(form({}));
    expect(redirect).toHaveBeenCalledWith("/subdivisions?error=land_missing");
  });

  it("refuses malformed country codes without starting anything", async () => {
    await rebuildSubdivisionsAction(form({ countries: "Greece" }));
    expect(redirect).toHaveBeenCalledWith("/subdivisions?error=unknown_country");
    expect(startSubdivisionsBuildRun).not.toHaveBeenCalled();
  });
});
