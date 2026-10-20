import { describe, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/worker";

/** What the handler passes to `summarizeProfile`. */
const probe = vi.hoisted(() => ({ inputs: [] as unknown[] }));

vi.mock("@/lib/pipeline/consolidation/summary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pipeline/consolidation/summary")>()),
  summarizeProfile: async (_db: unknown, input: unknown) => {
    probe.inputs.push(input);
    return { status: "ok", attempts: 1 };
  },
}));
vi.mock("@/lib/jobs/handlers/ai-batch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/handlers/ai-batch")>()),
  modelClientFor: () => ({}),
}));

const { consolidationSummaryHandler } = await import("@/lib/jobs/handlers/consolidation");

describe("consolidation.summary handler", () => {
  it("passes the job's regenerate flag of „Summary neu erzeugen“ on (ruling M6-H-R1)", async () => {
    const ctx = { db: {}, log: { info: () => undefined } } as unknown as JobContext;
    const base = { key: "g:1", runId: "run-1", stage: "consolidation.summary", geoObjectId: "g", version: 1 };
    await consolidationSummaryHandler({ ...base, regenerate: true }, ctx);
    await consolidationSummaryHandler(base, ctx);
    expect(probe.inputs).toEqual([
      { geoObjectId: "g", version: 1, runId: "run-1", regenerate: true },
      { geoObjectId: "g", version: 1, runId: "run-1", regenerate: false },
    ]);
  });
});
