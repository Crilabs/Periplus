import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { rateLimits } from "@/lib/db/schema";

export type TakeTokenResult = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Token bucket in Postgres: capacity = ratePerMinute, refilling ratePerMinute per 60 s.
 * The bucket row is locked with SELECT ... FOR UPDATE so concurrent callers serialise.
 */
export async function takeToken(
  db: Db,
  key: string,
  ratePerMinute: number,
  now: Date = new Date(),
): Promise<TakeTokenResult> {
  return db.transaction(async (tx) => {
    await tx
      .insert(rateLimits)
      .values({ key, tokens: ratePerMinute, updatedAt: now })
      .onConflictDoNothing({ target: rateLimits.key });
    const [row] = await tx
      .select()
      .from(rateLimits)
      .where(eq(rateLimits.key, key))
      .for("update");
    if (!row) throw new Error(`rate limit row missing for ${key}`);

    const perMs = ratePerMinute / 60_000;
    const elapsedMs = Math.max(0, now.getTime() - row.updatedAt.getTime());
    const available = Math.min(ratePerMinute, row.tokens + elapsedMs * perMs);

    if (available >= 1) {
      await tx.update(rateLimits).set({ tokens: available - 1, updatedAt: now }).where(eq(rateLimits.key, key));
      return { ok: true } as const;
    }
    await tx.update(rateLimits).set({ tokens: available, updatedAt: now }).where(eq(rateLimits.key, key));
    return { ok: false, retryAfterMs: Math.max(1, Math.ceil((1 - available) / perMs)) } as const;
  });
}
