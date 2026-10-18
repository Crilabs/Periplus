import { and, count, eq, gt } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { loginAttempts, users } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { hashPassword, verifyPassword } from "@/lib/security/password";

const log = createLogger("users");

const WINDOW_MS = 15 * 60_000;
const MAX_FAILED = 10;

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

// Verified against for unknown emails so response time does not reveal whether an account exists.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  return dummyHash;
}

export type AuthResult =
  | { ok: true; user: { id: string; email: string } }
  | { ok: false; reason: "invalid" | "rate_limited" | "disabled" };

async function recentFailures(db: Db, column: "email" | "ip", value: string, now: Date): Promise<number> {
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
  const email = normalizeEmail(input.email);
  const record = (success: boolean) => db.insert(loginAttempts).values({ email, ip: input.ip, success, at: now });

  const [byEmail, byIp] = await Promise.all([recentFailures(db, "email", email, now), recentFailures(db, "ip", input.ip, now)]);
  if (byEmail >= MAX_FAILED || byIp >= MAX_FAILED) {
    await record(false);
    log.warn({ ip: input.ip }, "login rate limited");
    return { ok: false, reason: "rate_limited" };
  }

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const passwordOk = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), input.password);

  if (!user || !passwordOk) {
    await record(false);
    return { ok: false, reason: "invalid" };
  }
  // Only reveal "disabled" to someone who knows the password.
  if (user.disabledAt) {
    await record(false);
    return { ok: false, reason: "disabled" };
  }

  await record(true);
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
  return { ok: true, user: { id: user.id, email: user.email } };
}
