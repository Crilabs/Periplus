import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";

/*
 * „Marina-Websites suchen“ on /runs (spec 16 C „Crawl“): the action checks the subdivision key, starts the run as the
 * admin and opens it; a refused start returns to /runs with its reason. The starter is tested in
 * lib/pipeline/__tests__/place-website-run.test.ts.
 */

const requireAdmin = vi.fn();
const redirect = vi.fn();
const startPlaceWebsiteRun = vi.fn();

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db/client")>()), getDb: () => ({ db: "test" }) }));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({ boss: "test" }) }));
vi.mock("@/lib/pipeline/place-website-run", () => ({ startPlaceWebsiteRun: (...args: unknown[]) => startPlaceWebsiteRun(...args) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import { startPlaceWebsiteAction } from "../runs/actions";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

beforeEach(() => {
  vi.resetAllMocks();
  requireAdmin.mockResolvedValue({ email: "admin@example.invalid" });
  startPlaceWebsiteRun.mockResolvedValue({ id: "run-9" });
});

describe("startPlaceWebsiteAction", () => {
  it("starts the marina website run of a subdivision as the admin and opens the run", async () => {
    await startPlaceWebsiteAction(form({ subdivisionKey: "GR-I" }));
    expect(startPlaceWebsiteRun).toHaveBeenCalledWith({ db: "test" }, { boss: "test" }, { subdivisionKey: "GR-I" }, "admin@example.invalid");
    expect(redirect).toHaveBeenCalledWith("/runs/run-9");
  });

  it("returns a refused start to /runs with its reason", async () => {
    startPlaceWebsiteRun.mockRejectedValue(new RunScopeNotReady("source_run_active", "busy"));
    await startPlaceWebsiteAction(form({ subdivisionKey: "GR-I" }));
    expect(redirect).toHaveBeenCalledWith("/runs?error=source_run_active");
  });

  it("starts nothing without a session or a subdivision key", async () => {
    await expect(startPlaceWebsiteAction(form({}))).rejects.toThrow();
    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(startPlaceWebsiteAction(form({ subdivisionKey: "GR-I" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(startPlaceWebsiteRun).not.toHaveBeenCalled();
  });
});
