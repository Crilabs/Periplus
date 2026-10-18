import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  refreshSessionToken,
  sessionCookieOptions,
  SESSION_COOKIE,
  verifySessionToken,
} from "../session";

const u = { id: "00000000-0000-7000-8000-000000000001", email: "a@test.invalid" };
const t0 = new Date("2026-01-01T00:00:00Z");
const addHours = (d: Date, h: number) => new Date(d.getTime() + h * 3600_000);
// Tamper a character in the middle of the signature segment (the last char carries base64url padding bits).
const tamperSignature = (t: string) => {
  const i = t.lastIndexOf(".") + 1 + 20;
  return t.slice(0, i) + (t[i] === "A" ? "B" : "A") + t.slice(i + 1);
};

describe("session tokens", () => {
  it("round-trips claims", async () => {
    const t = await createSessionToken(u, t0);
    const c = await verifySessionToken(t, t0);
    expect(c).toMatchObject({ sub: u.id, email: u.email });
    expect(c!.exp - c!.iat).toBe(12 * 3600);
    expect(c!.abs - c!.iat).toBe(7 * 24 * 3600);
  });

  it("returns null for a tampered token", async () => {
    const t = await createSessionToken(u, t0);
    expect(await verifySessionToken(tamperSignature(t), t0)).toBeNull();
  });

  it("returns null for missing and malformed tokens", async () => {
    expect(await verifySessionToken(undefined, t0)).toBeNull();
    expect(await verifySessionToken("", t0)).toBeNull();
    expect(await verifySessionToken("garbage", t0)).toBeNull();
  });

  it("returns null after 12h without refresh", async () => {
    const t = await createSessionToken(u, t0);
    expect(await verifySessionToken(t, addHours(t0, 12.01))).toBeNull();
  });

  it("refresh slides the expiry by 12h", async () => {
    const t = await createSessionToken(u, t0);
    const now = addHours(t0, 11);
    const r = await refreshSessionToken((await verifySessionToken(t, now))!, now);
    expect(await verifySessionToken(r!, addHours(t0, 22))).not.toBeNull();
    expect(await verifySessionToken(r!, addHours(t0, 23.01))).toBeNull();
  });

  it("refresh never extends past the 7-day absolute limit", async () => {
    let t = await createSessionToken(u, t0);
    // keep the session alive with a refresh every 10h
    for (let h = 10; h < 6.9 * 24; h += 10) {
      const now = addHours(t0, h);
      const claims = await verifySessionToken(t, now);
      expect(claims).not.toBeNull();
      t = (await refreshSessionToken(claims!, now))!;
    }
    const now = addHours(t0, 6.9 * 24);
    const claims = await verifySessionToken(t, now);
    const r = await refreshSessionToken(claims!, now);
    expect(await verifySessionToken(r!, addHours(t0, 7 * 24 + 0.01))).toBeNull();
    expect(await verifySessionToken(r!, addHours(t0, 7 * 24 - 0.01))).not.toBeNull();
  });

  it("refresh returns null once past abs", async () => {
    const t = await createSessionToken(u, t0);
    const claims = (await verifySessionToken(t, t0))!;
    expect(await refreshSessionToken(claims, addHours(t0, 7 * 24 + 1))).toBeNull();
  });

  it("exposes cookie name and options", () => {
    expect(SESSION_COOKIE).toBe("periplus_session");
    expect(sessionCookieOptions()).toEqual({ httpOnly: true, secure: false, sameSite: "lax", path: "/" });
  });
});
