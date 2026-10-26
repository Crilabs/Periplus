import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { mcpTokens, users } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import {
  createMcpToken,
  listMcpTokens,
  MAX_ACTIVE_MCP_TOKENS,
  McpTokenLimitReached,
  resolveMcpToken,
  revokeMcpToken,
} from "@/lib/domain/mcp-tokens";
import { withRollback } from "@/test/db";

const NOW = new Date("2026-10-26T08:00:00Z");

async function user(tx: Db): Promise<string> {
  const [row] = await tx.insert(users).values({ email: `${newId()}@test.invalid`, passwordHash: "x" }).returning({ id: users.id });
  return row!.id;
}

const bearer = (token: string) => `Bearer ${token}`;

describe("MCP tokens", () => {
  it("a created token resolves to its owner; the plaintext is never stored", () =>
    withRollback(async (tx) => {
      const userId = await user(tx);
      const { id, token, expiresAt } = await createMcpToken(tx, { userId, name: "Laptop", validityDays: 90, now: NOW });
      expect(token).toMatch(/^pmcp_[A-Za-z0-9_-]{43}$/);
      expect(expiresAt.toISOString()).toBe("2027-01-24T08:00:00.000Z");
      const [row] = await tx.select().from(mcpTokens).where(eq(mcpTokens.id, id));
      expect(row!.tokenHash).not.toContain(token.slice(5));
      expect(row!.prefix).toBe(token.slice(0, 15));
      expect(await resolveMcpToken(tx, bearer(token), NOW)).toMatchObject({ tokenId: id, userId });
    }));

  it("no header, a malformed, unknown, expired or revoked token, a deactivated owner: all null", () =>
    withRollback(async (tx) => {
      const userId = await user(tx);
      const { id, token } = await createMcpToken(tx, { userId, name: "a", validityDays: 30, now: NOW });
      expect(await resolveMcpToken(tx, null, NOW)).toBeNull();
      expect(await resolveMcpToken(tx, "Bearer pk_abc", NOW)).toBeNull();
      expect(await resolveMcpToken(tx, bearer(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")), NOW)).toBeNull();
      expect(await resolveMcpToken(tx, bearer(token), new Date("2026-11-26T08:00:00Z"))).toBeNull();

      await tx.update(users).set({ disabledAt: NOW }).where(eq(users.id, userId));
      expect(await resolveMcpToken(tx, bearer(token), NOW)).toBeNull();
      await tx.update(users).set({ disabledAt: null }).where(eq(users.id, userId));
      expect(await resolveMcpToken(tx, bearer(token), NOW)).not.toBeNull();

      await revokeMcpToken(tx, userId, id);
      expect(await resolveMcpToken(tx, bearer(token), NOW)).toBeNull();
    }));

  it("a user lists and revokes only their own tokens", () =>
    withRollback(async (tx) => {
      const alice = await user(tx);
      const bob = await user(tx);
      const a = await createMcpToken(tx, { userId: alice, name: "a", validityDays: 30, now: NOW });
      await createMcpToken(tx, { userId: bob, name: "b", validityDays: 30, now: NOW });
      expect((await listMcpTokens(tx, alice)).map((t) => t.name)).toEqual(["a"]);
      await revokeMcpToken(tx, bob, a.id);
      expect(await resolveMcpToken(tx, bearer(a.token), NOW)).not.toBeNull();
    }));

  it("at most 10 active tokens; a revoked or expired one does not count", () =>
    withRollback(async (tx) => {
      const userId = await user(tx);
      const ids: string[] = [];
      for (let i = 0; i < MAX_ACTIVE_MCP_TOKENS; i++) ids.push((await createMcpToken(tx, { userId, name: `t${i}`, validityDays: 30, now: NOW })).id);
      await expect(createMcpToken(tx, { userId, name: "one more", validityDays: 30, now: NOW })).rejects.toBeInstanceOf(McpTokenLimitReached);
      await revokeMcpToken(tx, userId, ids[0]!);
      await expect(createMcpToken(tx, { userId, name: "now", validityDays: 30, now: NOW })).resolves.toMatchObject({ token: expect.any(String) });
    }));

  it("last_used_at is touched at most once a minute", () =>
    withRollback(async (tx) => {
      const userId = await user(tx);
      const { id, token } = await createMcpToken(tx, { userId, name: "a", validityDays: 30, now: NOW });
      const lastUsed = async () => (await tx.select().from(mcpTokens).where(eq(mcpTokens.id, id)))[0]!.lastUsedAt?.toISOString();
      await resolveMcpToken(tx, bearer(token), NOW);
      await resolveMcpToken(tx, bearer(token), new Date(NOW.getTime() + 30_000));
      expect(await lastUsed()).toBe(NOW.toISOString());
      await resolveMcpToken(tx, bearer(token), new Date(NOW.getTime() + 61_000));
      expect(await lastUsed()).toBe(new Date(NOW.getTime() + 61_000).toISOString());
    }));
});
