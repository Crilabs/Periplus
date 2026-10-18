import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getDb } from "@/lib/db/client";
import { isUserActive } from "@/lib/domain/users";
import { SESSION_COOKIE, verifySessionToken, type SessionClaims } from "./session";

/** The claims of a valid session of an active user, else null. Never cached: reads the request cookie. */
export async function adminSession(): Promise<SessionClaims | null> {
  await connection(); // session expiry depends on the current time, so never prerender this
  const claims = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!claims || !(await isUserActive(getDb(), claims.sub))) return null;
  return claims;
}

/** Call in every admin page and server action; redirects to /login when the session is invalid or the user is disabled. */
export async function requireAdmin(): Promise<SessionClaims> {
  const claims = await adminSession();
  if (!claims) redirect("/login");
  return claims;
}

/** Response for an admin route handler without a valid session: 401, no data (route handlers never redirect). */
export function unauthorizedResponse(): Response {
  return Response.json({ error: { code: "unauthorized" } }, { status: 401, headers: { "Cache-Control": "no-store" } });
}
