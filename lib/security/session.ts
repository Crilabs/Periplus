import { jwtVerify, SignJWT } from "jose";
import { getEnv } from "@/lib/env";

export const SESSION_COOKIE = "periplus_session";

export type SessionClaims = { sub: string; email: string; iat: number; exp: number; abs: number };

const SLIDING_SECONDS = 12 * 3600;
const ABSOLUTE_SECONDS = 7 * 24 * 3600;

function key(): Uint8Array {
  return new TextEncoder().encode(getEnv().SESSION_SECRET);
}

const toSeconds = (d: Date) => Math.floor(d.getTime() / 1000);

async function sign(user: { id: string; email: string }, nowSec: number, abs: number): Promise<string> {
  return new SignJWT({ email: user.email, abs })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt(nowSec)
    .setExpirationTime(Math.min(nowSec + SLIDING_SECONDS, abs))
    .sign(key());
}

/** `absoluteExpiry` is in epoch seconds; defaults to now + 7 days. */
export async function createSessionToken(
  user: { id: string; email: string },
  now: Date = new Date(),
  absoluteExpiry?: number,
): Promise<string> {
  const nowSec = toSeconds(now);
  return sign(user, nowSec, absoluteExpiry ?? nowSec + ABSOLUTE_SECONDS);
}

/** Returns null (never throws) for missing, malformed, tampered, expired or past-abs tokens. */
export async function verifySessionToken(token: string | undefined, now: Date = new Date()): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"], currentDate: now });
    const { sub, email, iat, exp, abs } = payload;
    if (typeof sub !== "string" || typeof email !== "string") return null;
    if (typeof iat !== "number" || typeof exp !== "number" || typeof abs !== "number") return null;
    if (toSeconds(now) >= abs) return null;
    return { sub, email, iat, exp, abs };
  } catch {
    return null;
  }
}

/** Slides the expiry by 12 h (capped at abs); null when the absolute limit has passed. */
export async function refreshSessionToken(claims: SessionClaims, now: Date = new Date()): Promise<string | null> {
  const nowSec = toSeconds(now);
  if (nowSec >= claims.abs) return null;
  return sign({ id: claims.sub, email: claims.email }, nowSec, claims.abs);
}

export function sessionCookieOptions(): { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/" } {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" };
}
