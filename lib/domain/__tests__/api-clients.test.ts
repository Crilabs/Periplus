import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { newId } from "@/lib/domain/ids";
import { authenticateApiClient, createApiClient, revokeApiClient, revokeApiClientByName } from "@/lib/domain/api-clients";
import { generateApiKey, hashApiKey } from "@/lib/security/api-keys";

const db = testDb();

describe("api keys", () => {
  it("generates pk_ + 43 base62 chars and a matching sha256 hash", () => {
    const { key, hash } = generateApiKey();
    expect(key).toMatch(/^pk_[0-9A-Za-z]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).toBe(hash);
    expect(generateApiKey().key).not.toBe(key);
  });
});

describe("api clients", () => {
  it("authenticates a created key and rejects a revoked one", async () => {
    const { id, key } = await createApiClient(db, { name: `test-${newId()}`, scopes: ["delivery:read"], rateLimitPerMin: 5 });
    const client = await authenticateApiClient(db, `Bearer ${key}`);
    expect(client).toMatchObject({ id, scopes: ["delivery:read"], rateLimitPerMin: 5 });
    await revokeApiClient(db, id);
    expect(await authenticateApiClient(db, `Bearer ${key}`)).toBeNull();
  });

  it("revoked key no longer authenticates when revoked by name", async () => {
    const name = `test-${newId()}`;
    const { key } = await createApiClient(db, { name, scopes: ["delivery:read"] });
    expect(await authenticateApiClient(db, `Bearer ${key}`)).not.toBeNull();
    await revokeApiClientByName(db, name);
    expect(await authenticateApiClient(db, `Bearer ${key}`)).toBeNull();
    await expect(revokeApiClientByName(db, `unknown-${newId()}`)).rejects.toThrow("api_client_not_found");
  });

  it("stores only the hash, never the key", async () => {
    const { id, key } = await createApiClient(db, { name: `test-${newId()}`, scopes: [] });
    const rows = await db.query.apiClients.findMany({ where: (t, { eq }) => eq(t.id, id) });
    expect(rows[0].keyHash).toBe(hashApiKey(key));
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(rows[0].rateLimitPerMin).toBe(60);
  });

  it("rejects a key with a valid prefix but unknown hash", async () => {
    expect(await authenticateApiClient(db, "Bearer pk_" + "a".repeat(43))).toBeNull();
  });

  it("rejects missing, non-Bearer and malformed headers", async () => {
    const { key } = await createApiClient(db, { name: `test-${newId()}`, scopes: [] });
    expect(await authenticateApiClient(db, null)).toBeNull();
    expect(await authenticateApiClient(db, key)).toBeNull();
    expect(await authenticateApiClient(db, `Basic ${key}`)).toBeNull();
    expect(await authenticateApiClient(db, `Bearer  ${key}`)).toBeNull();
  });
});
