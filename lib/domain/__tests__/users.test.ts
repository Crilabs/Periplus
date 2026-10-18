import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { loginAttempts, users } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { authenticate, createUser, setPassword } from "../users";

const db = testDb();
const correct = "correct horse battery";
const t0 = new Date("2026-03-01T10:00:00Z");
const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const fresh = () => ({ email: `${newId()}@test.invalid`, ip: `ip-${newId()}` });

describe("users", () => {
  it("creates a user with a lowercased email and an argon2id hash", async () => {
    const { email } = fresh();
    const { id } = await createUser(db, email.toUpperCase(), correct);
    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(row!.email).toBe(email.toLowerCase());
    expect(row!.passwordHash.startsWith("$argon2id$")).toBe(true);
  });

  it("authenticates with the right password, case-insensitive email", async () => {
    const { email, ip } = fresh();
    const { id } = await createUser(db, email, correct);
    const r = await authenticate(db, { email: email.toUpperCase(), password: correct, ip }, t0);
    expect(r).toEqual({ ok: true, user: { id, email } });
    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(row!.lastLoginAt?.getTime()).toBe(t0.getTime());
  });

  it("returns invalid for a wrong password and unknown email alike", async () => {
    const a = fresh();
    await createUser(db, a.email, correct);
    expect(await authenticate(db, { email: a.email, password: "wrong-password-x", ip: a.ip }, t0)).toEqual({ ok: false, reason: "invalid" });
    const b = fresh();
    expect(await authenticate(db, { email: b.email, password: "wrong-password-x", ip: b.ip }, t0)).toEqual({ ok: false, reason: "invalid" });
  });

  it("records every attempt", async () => {
    const { email, ip } = fresh();
    await createUser(db, email, correct);
    await authenticate(db, { email, password: "wrong-password-x", ip }, t0);
    await authenticate(db, { email, password: correct, ip }, t0);
    const rows = await db.select().from(loginAttempts).where(eq(loginAttempts.ip, ip));
    expect(rows.map((r) => r.success).sort()).toEqual([false, true]);
  });

  it("returns rate_limited on the 11th attempt in 15 minutes even with the right password", async () => {
    const { email, ip } = fresh();
    await createUser(db, email, correct);
    for (let i = 0; i < 10; i++) await authenticate(db, { email, password: "wrong-password-x", ip }, t0);
    expect(await authenticate(db, { email, password: correct, ip }, addMinutes(t0, 5))).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("rate limits per email across different IPs", async () => {
    const { email } = fresh();
    await createUser(db, email, correct);
    for (let i = 0; i < 10; i++) await authenticate(db, { email, password: "wrong-password-x", ip: `ip-${newId()}` }, t0);
    expect(await authenticate(db, { email, password: correct, ip: `ip-${newId()}` }, addMinutes(t0, 1))).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("rate limits per IP across different emails", async () => {
    const { ip } = fresh();
    for (let i = 0; i < 10; i++) await authenticate(db, { email: fresh().email, password: "wrong-password-x", ip }, t0);
    const u = fresh();
    await createUser(db, u.email, correct);
    expect(await authenticate(db, { email: u.email, password: correct, ip }, addMinutes(t0, 1))).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("allows login again after the 15-minute window", async () => {
    const { email, ip } = fresh();
    await createUser(db, email, correct);
    for (let i = 0; i < 10; i++) await authenticate(db, { email, password: "wrong-password-x", ip }, t0);
    const r = await authenticate(db, { email, password: correct, ip }, addMinutes(t0, 16));
    expect(r.ok).toBe(true);
  });

  it("returns disabled for a disabled user", async () => {
    const { email, ip } = fresh();
    await createUser(db, email, correct);
    await db.update(users).set({ disabledAt: t0 }).where(eq(users.email, email));
    expect(await authenticate(db, { email, password: correct, ip }, t0)).toEqual({ ok: false, reason: "disabled" });
  });

  it("setPassword replaces the password", async () => {
    const { email, ip } = fresh();
    await createUser(db, email, correct);
    await setPassword(db, email, "another long password");
    expect((await authenticate(db, { email, password: correct, ip }, t0)).ok).toBe(false);
    expect((await authenticate(db, { email, password: "another long password", ip }, t0)).ok).toBe(true);
  });

  it("setPassword throws for an unknown user", async () => {
    await expect(setPassword(db, fresh().email, correct)).rejects.toThrow("user_not_found");
  });
});
