import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { mcpTokens, users } from "@/lib/db/schema/auth";

/*
 * Personal MCP tokens (plan 2026-10-26-periplus-mcp, after SITA ADR 0007): `pmcp_` + 43 base64url characters
 * (32 random bytes). Stored: the SHA-256 hash and the first 15 characters as prefix (not secret, finds the rows).
 * A token acts as its owner and only reads; it dies with its expiry, its revocation or its owner's deactivation.
 */

export const MCP_TOKEN_PREFIX = "pmcp_";
const TOKEN_PATTERN = /^pmcp_[A-Za-z0-9_-]{43}$/;
const PREFIX_LENGTH = MCP_TOKEN_PREFIX.length + 10;
export const MCP_TOKEN_VALIDITY_DAYS = [30, 90, 365] as const;
export type McpTokenValidityDays = (typeof MCP_TOKEN_VALIDITY_DAYS)[number];
export const MAX_ACTIVE_MCP_TOKENS = 10;
const TOUCH_INTERVAL_MS = 60_000;

export class McpTokenLimitReached extends Error {
  constructor() {
    super(`At most ${MAX_ACTIVE_MCP_TOKENS} active MCP tokens per user`);
  }
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** A fresh token: the plaintext (shown once), its hash and its prefix. */
export function generateMcpToken(): { token: string; hash: string; prefix: string } {
  const token = MCP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hash(token), prefix: token.slice(0, PREFIX_LENGTH) };
}

/**
 * Creates a token for `userId`. The user row is locked, so parallel creates cannot pass the cap of active tokens.
 * Returns the plaintext once; Periplus never shows it again.
 */
export async function createMcpToken(
  db: Db,
  input: { userId: string; name: string; validityDays: McpTokenValidityDays; now?: Date },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const name = input.name.trim().slice(0, 60);
  if (name === "") throw new Error("name_required");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${users} where ${users.id} = ${input.userId} for no key update`);
    const [{ active }] = await tx
      .select({ active: sql<number>`count(*)::int` })
      .from(mcpTokens)
      .where(and(eq(mcpTokens.userId, input.userId), isNull(mcpTokens.revokedAt), gt(mcpTokens.expiresAt, now)));
    if (active >= MAX_ACTIVE_MCP_TOKENS) throw new McpTokenLimitReached();
    const { token, hash: tokenHash, prefix } = generateMcpToken();
    const expiresAt = new Date(now.getTime() + input.validityDays * 86_400_000);
    const [row] = await tx.insert(mcpTokens).values({ userId: input.userId, name, prefix, tokenHash, expiresAt }).returning({ id: mcpTokens.id });
    return { id: row!.id, token, expiresAt };
  });
}

export type McpTokenRow = { id: string; name: string; prefix: string; expiresAt: Date; revokedAt: Date | null; lastUsedAt: Date | null; createdAt: Date };

/** The user's own tokens, newest first (never the hash). */
export async function listMcpTokens(db: Db, userId: string): Promise<McpTokenRow[]> {
  return db
    .select({
      id: mcpTokens.id,
      name: mcpTokens.name,
      prefix: mcpTokens.prefix,
      expiresAt: mcpTokens.expiresAt,
      revokedAt: mcpTokens.revokedAt,
      lastUsedAt: mcpTokens.lastUsedAt,
      createdAt: mcpTokens.createdAt,
    })
    .from(mcpTokens)
    .where(eq(mcpTokens.userId, userId))
    .orderBy(desc(mcpTokens.createdAt));
}

/** Revokes one of the user's own tokens; a foreign or unknown id changes nothing, a second revoke is a no-op. */
export async function revokeMcpToken(db: Db, userId: string, id: string): Promise<void> {
  await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.id, id), eq(mcpTokens.userId, userId), isNull(mcpTokens.revokedAt)));
}

export type McpCaller = { tokenId: string; userId: string; email: string };

/**
 * The caller behind `Authorization: Bearer pmcp_…`, or null: no or malformed header, unknown, expired or revoked token,
 * deactivated owner (all alike, the route answers one 401). Touches `last_used_at` at most once a minute.
 */
export async function resolveMcpToken(db: Db, authorization: string | null, now: Date = new Date()): Promise<McpCaller | null> {
  const match = authorization ? /^Bearer (\S+)$/.exec(authorization) : null;
  const token = match?.[1];
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const candidates = await db
    .select({ id: mcpTokens.id, tokenHash: mcpTokens.tokenHash, userId: mcpTokens.userId, lastUsedAt: mcpTokens.lastUsedAt, email: users.email, disabledAt: users.disabledAt })
    .from(mcpTokens)
    .innerJoin(users, eq(users.id, mcpTokens.userId))
    .where(and(eq(mcpTokens.prefix, token.slice(0, PREFIX_LENGTH)), isNull(mcpTokens.revokedAt), gt(mcpTokens.expiresAt, now)))
    .limit(5);
  const wanted = Buffer.from(hash(token), "hex");
  const row = candidates.find((c) => {
    const stored = Buffer.from(c.tokenHash, "hex");
    return stored.length === wanted.length && timingSafeEqual(stored, wanted);
  });
  if (!row || row.disabledAt !== null) return null;
  if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
    await db.update(mcpTokens).set({ lastUsedAt: now }).where(eq(mcpTokens.id, row.id));
  }
  return { tokenId: row.id, userId: row.userId, email: row.email };
}
