import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { apiClients } from "@/lib/db/schema/auth";
import { generateApiKey, hashApiKey } from "@/lib/security/api-keys";

export type ApiScope = "delivery:read" | "reports:write";

export type ApiClient = { id: string; name: string; scopes: ApiScope[]; rateLimitPerMin: number };

export async function createApiClient(
  db: Db,
  input: { name: string; scopes: ApiScope[]; rateLimitPerMin?: number },
): Promise<{ id: string; key: string }> {
  const { key, hash } = generateApiKey();
  const [row] = await db
    .insert(apiClients)
    .values({
      name: input.name,
      keyHash: hash,
      scopes: input.scopes,
      ...(input.rateLimitPerMin === undefined ? {} : { rateLimitPerMin: input.rateLimitPerMin }),
    })
    .returning({ id: apiClients.id });
  return { id: row.id, key };
}

/** Bearer scheme only. Unknown, malformed and revoked keys all yield null. */
export async function authenticateApiClient(db: Db, authorization: string | null): Promise<ApiClient | null> {
  const match = authorization ? /^Bearer (\S+)$/.exec(authorization) : null;
  if (!match || !match[1].startsWith("pk_")) return null;
  const [row] = await db
    .select()
    .from(apiClients)
    .where(and(eq(apiClients.keyHash, hashApiKey(match[1])), isNull(apiClients.revokedAt)))
    .limit(1);
  if (!row) return null;
  return { id: row.id, name: row.name, scopes: row.scopes as ApiScope[], rateLimitPerMin: row.rateLimitPerMin };
}

export async function revokeApiClientByName(db: Db, name: string): Promise<void> {
  const rows = await db
    .update(apiClients)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiClients.name, name), isNull(apiClients.revokedAt)))
    .returning({ id: apiClients.id });
  if (rows.length === 0) throw new Error("api_client_not_found");
}

export async function revokeApiClient(db: Db, id: string): Promise<void> {
  await db
    .update(apiClients)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiClients.id, id), isNull(apiClients.revokedAt)));
}
