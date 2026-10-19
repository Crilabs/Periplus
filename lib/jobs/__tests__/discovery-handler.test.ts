import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@/lib/adapters/http";
import type { JobContext } from "@/lib/jobs/worker";

/** The transports the handler hands out, told apart by identity. */
const probe = vi.hoisted(() => ({
  crawl: (async () => {
    throw new Error("crawl transport is a sentinel");
  }) as unknown as Transport,
  passed: [] as unknown[],
}));

vi.mock("@/lib/adapters/fetch/guarded", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters/fetch/guarded")>()),
  getCrawlTransport: () => probe.crawl,
}));

vi.mock("@/lib/domain/discovery/proposals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/domain/discovery/proposals")>()),
  proposeSources: async (_db: unknown, deps: { transport: Transport }) => {
    probe.passed.push(deps.transport);
    return { proposed: 0, skipped: 0 };
  },
}));

const { discoveryProposeHandler } = await import("@/lib/jobs/handlers/discovery");

describe("discovery.propose handler", () => {
  it("reads the proposals' robots.txt through the guarded crawl transport", async () => {
    const ctx = { db: {}, log: { info: () => undefined } } as unknown as JobContext;
    await discoveryProposeHandler({ key: "propose", runId: "run-1", stage: "discovery.propose" }, ctx);
    expect(probe.passed).toEqual([probe.crawl]);
  });
});
