import { describe, expect, it } from "vitest";
import journal from "@/drizzle/meta/_journal.json";
import { getConfig } from "@/lib/config";
import { configHash, deployVersion } from "@/lib/domain/mcp/version";
import { gateConfigOf } from "@/lib/domain/research/gate-report";
import { testDb } from "@/test/db";

describe("configHash", () => {
  it("is 16 hex characters and independent of the key order, at any depth", () => {
    const a = configHash({ x: 1, y: { p: [1, 2], q: "z" } });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(configHash({ y: { q: "z", p: [1, 2] }, x: 1 })).toBe(a);
  });

  it("changes with a value and with the order of an array", () => {
    expect(configHash({ x: 1 })).not.toBe(configHash({ x: 2 }));
    expect(configHash({ x: [1, 2] })).not.toBe(configHash({ x: [2, 1] }));
  });
});

describe("deployVersion", () => {
  it("reports the git sha from the env, null without", async () => {
    const cfg = getConfig();
    expect((await deployVersion(testDb(), cfg, { GIT_SHA: "abc123" })).gitSha).toBe("abc123");
    expect((await deployVersion(testDb(), cfg, {})).gitSha).toBeNull();
  });

  it("reports the last journal migration of the database", async () => {
    const v = await deployVersion(testDb(), getConfig(), {});
    expect(v.lastMigration?.tag).toBe(journal.entries.at(-1)!.tag);
    expect(Number.isNaN(Date.parse(v.lastMigration!.appliedAt))).toBe(false);
  });

  it("hashes the effective config and the gate part of it", async () => {
    const cfg = getConfig();
    const v = await deployVersion(testDb(), cfg, {});
    expect(v.gateConfigHash).toBe(configHash(gateConfigOf(cfg)));
    expect(v.configHash).toBe(configHash(v.config));
    expect(v.config).toEqual({ research: cfg.research, quality: cfg.quality, budgets: cfg.budgets, models: cfg.models });
  });
});
