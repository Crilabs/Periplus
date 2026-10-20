import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";

/*
 * „Revisit für Revier“ on /runs (plan Task 13, ruling M7-P22): the action checks the area, starts the revisit run as the
 * admin and redirects to it; a refused start returns to /runs with the German flash code. The starter itself is tested in
 * lib/pipeline/__tests__/revisit.test.ts.
 */

const requireAdmin = vi.fn();
const redirect = vi.fn();
const startRevisitRun = vi.fn();

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db/client")>()), getDb: () => ({ db: "test" }) }));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({ boss: "test" }) }));
vi.mock("@/lib/pipeline/revisit-run", () => ({ startRevisitRun: (...args: unknown[]) => startRevisitRun(...args) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import { startRevisitAction } from "../runs/actions";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

beforeEach(() => {
  vi.resetAllMocks();
  requireAdmin.mockResolvedValue({ email: "admin@example.invalid" });
  startRevisitRun.mockResolvedValue({ id: "run-7" });
});

describe("startRevisitAction", () => {
  it("starts the revisit of a configured area as the admin and opens the run", async () => {
    await startRevisitAction(form({ areaKey: "saronic" }));
    expect(startRevisitRun).toHaveBeenCalledWith({ db: "test" }, { boss: "test" }, { areaKey: "saronic", triggeredBy: "admin@example.invalid" });
    expect(redirect).toHaveBeenCalledWith("/runs/run-7");
  });

  it("returns a refused start to /runs with its reason", async () => {
    startRevisitRun.mockRejectedValue(new RunScopeNotReady("source_run_active", "busy"));
    await startRevisitAction(form({ areaKey: "saronic" }));
    expect(redirect).toHaveBeenCalledWith("/runs?error=source_run_active");
  });

  it("rejects an unknown area and a missing session without starting anything", async () => {
    await expect(startRevisitAction(form({ areaKey: "atlantis" }))).rejects.toThrow();
    requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(startRevisitAction(form({ areaKey: "saronic" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(startRevisitRun).not.toHaveBeenCalled();
  });
});
