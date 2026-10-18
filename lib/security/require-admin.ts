import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { SESSION_COOKIE, verifySessionToken, type SessionClaims } from "./session";

/** Call in every admin page and server action; redirects to /login when the session is invalid. */
export async function requireAdmin(): Promise<SessionClaims> {
  await connection(); // session expiry depends on the current time, so never prerender this
  const claims = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!claims) redirect("/login");
  return claims;
}
