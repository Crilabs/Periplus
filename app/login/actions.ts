"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { authenticate } from "@/lib/domain/users";
import { safeNext } from "@/lib/security/safe-next";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/security/session";

export type LoginState = { error: "invalid" | "rate_limited" | null };

async function clientIp(): Promise<string> {
  const forwarded = (await headers()).get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = formData.get("email");
  const password = formData.get("password");
  if (typeof email !== "string" || typeof password !== "string") return { error: "invalid" };

  const result = await authenticate(getDb(), { email, password, ip: await clientIp() });
  if (!result.ok) {
    // "disabled" is deliberately indistinguishable from "invalid".
    return { error: result.reason === "rate_limited" ? "rate_limited" : "invalid" };
  }

  (await cookies()).set(SESSION_COOKIE, await createSessionToken(result.user), sessionCookieOptions());
  const next = formData.get("next");
  redirect(safeNext(typeof next === "string" ? next : null));
}
