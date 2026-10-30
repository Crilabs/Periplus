import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CostCapReached, CostLedger } from "../costs";

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pilot-costs-"));
}

describe("CostLedger", () => {
  it("starts at zero in an empty directory", async () => {
    const ledger = await CostLedger.open(await tmp());
    expect(ledger.totalEur).toBe(0);
  });

  it("persists the sum across reopening", async () => {
    const dir = await tmp();
    const ledger = await CostLedger.open(dir);
    await ledger.add({ stage: "search", service: "dataforseo", units: 1, costEur: 0.0035 });
    await ledger.add({ stage: "assess", service: "anthropic", units: 1, costEur: 0.01 });
    const reopened = await CostLedger.open(dir);
    expect(reopened.totalEur).toBeCloseTo(0.0135, 6);
  });

  it("refuses to open with a cap that is not a finite number", async () => {
    await expect(CostLedger.open(await tmp(), Number("50,00"))).rejects.toThrow(/cap/);
  });

  it("refuses a call that would pass the cap, across restarts", async () => {
    const dir = await tmp();
    const ledger = await CostLedger.open(dir, 40);
    await ledger.add({ stage: "assess", service: "anthropic", units: 1, costEur: 39.99 });
    const reopened = await CostLedger.open(dir, 40);
    expect(() => reopened.assertRoom(0.02)).toThrow(CostCapReached);
    expect(() => reopened.assertRoom(0.01)).not.toThrow();
  });
});
