import { and, count, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { loginAttempts, users } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { hashPassword, MAX_PASSWORD_LENGTH, verifyPassword } from "@/lib/security/password";


const WINDOW_MS = 15 * 60_000;
const MAX_FAILED = 10;
/** Longest address RFC 5321 allows; anything longer is no account's email (SEC-1). */
export const MAX_EMAIL_LENGTH = 320;
/** The client address kept per attempt (an IPv6 address with zone fits); a longer forwarded value is cut. */
const MAX_IP_LENGTH = 64;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function createUser(db: Db, email: string, password: string): Promise<{ id: string }> {
  const passwordHash = await hashPassword(password);
  const [row] = await db.insert(users).values({ email: normalizeEmail(email), passwordHash }).returning({ id: users.id });
  return { id: row!.id };
}

export async function setPassword(db: Db, email: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  const rows = await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.email, normalizeEmail(email)))
    .returning({ id: users.id });
  if (rows.length === 0) throw new Error("user_not_found");
}

export async function disableUser(db: Db, email: string): Promise<void> {
  const rows = await db
    .update(users)
    .set({ disabledAt: new Date() })
    .where(eq(users.email, normalizeEmail(email)))
    .returning({ id: users.id });
  if (rows.length === 0) throw new Error("user_not_found");
}

/** False for unknown and disabled users. */
export async function isUserActive(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return Boolean(row) && row!.disabledAt === null;
}

// Verified against for unknown emails so response time does not reveal whether an account exists.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  return dummyHash;
}

export type AuthResult =
  | { ok: true; user: { id: string; email: string } }
  | { ok: false; reason: "invalid" | "rate_limited" | "disabled" };

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function recentFailures(db: Tx, column: "email" | "ip", value: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const [row] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts[column], value), eq(loginAttempts.success, false), gt(loginAttempts.at, since)));
  return row?.n ?? 0;
}

export async function authenticate(
  db: Db,
  input: { email: string; password: string; ip: string },
  now: Date = new Date(),
): Promise<AuthResult> {
  // Over-long input is refused before any work (no Argon2, no lock, no insert): such an email or password belongs to no
  // account, and an index row that large would fail the attempt's insert, so the attempt would never count (SEC-1).
  if (input.email.length > MAX_EMAIL_LENGTH || input.password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: "invalid" } as const;
  }
  const email = normalizeEmail(input.email);
  // A long forwarded address (only possible without the Caddy edge) still counts, cut to its first characters.
  input = { ...input, ip: input.ip.slice(0, MAX_IP_LENGTH) };
  // Serialise attempts per email and per IP (fixed lock order: email, then ip) so concurrent
  // requests cannot all read the failure count before any of them records its own failure.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"login:email:" + email}))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"login:ip:" + input.ip}))`);

    const record = (success: boolean) => tx.insert(loginAttempts).values({ email, ip: input.ip, success, at: now });

    const byEmail = await recentFailures(tx, "email", email, now);
    const byIp = await recentFailures(tx, "ip", input.ip, now);
    if (byEmail >= MAX_FAILED || byIp >= MAX_FAILED) {
      await record(false);
      createLogger("users").warn({ ip: input.ip }, "login rate limited");
      return { ok: false, reason: "rate_limited" } as const;
    }

    const [user] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
    const passwordOk = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), input.password);

    if (!user || !passwordOk) {
      await record(false);
      return { ok: false, reason: "invalid" } as const;
    }
    // Only reveal "disabled" to someone who knows the password.
    if (user.disabledAt) {
      await record(false);
      return { ok: false, reason: "disabled" } as const;
    }

    await record(true);
    await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
    return { ok: true, user: { id: user.id, email: user.email } } as const;
  });
}
