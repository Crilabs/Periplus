"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { createMcpToken, MCP_TOKEN_VALIDITY_DAYS, McpTokenLimitReached, revokeMcpToken } from "@/lib/domain/mcp-tokens";
import { requireAdmin } from "@/lib/security/require-admin";

const createSchema = z.object({
  name: z.string().trim().min(1, "Name fehlt").max(60),
  validityDays: z.coerce.number().pipe(z.union(MCP_TOKEN_VALIDITY_DAYS.map((d) => z.literal(d)))),
});

export type CreateMcpTokenResult = { ok: true; token: string; expiresAt: string } | { ok: false; error: string };

/** „Token anlegen“ under Einstellungen → Claude Code (MCP): a token of the signed-in user; the plaintext is returned once. */
export async function createMcpTokenAction(input: { name: string; validityDays: number }): Promise<CreateMcpTokenResult> {
  const claims = await requireAdmin();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Ungültige Eingabe" };
  try {
    const { token, expiresAt } = await createMcpToken(getDb(), { userId: claims.sub, ...parsed.data });
    revalidatePath("/settings");
    return { ok: true, token, expiresAt: expiresAt.toISOString() };
  } catch (e) {
    if (e instanceof McpTokenLimitReached) return { ok: false, error: "Höchstens 10 aktive Tokens. Erst ein altes widerrufen." };
    throw e;
  }
}

/** „Widerrufen“: one of the signed-in user's own tokens; it fails from now on. */
export async function revokeMcpTokenAction(input: FormData): Promise<void> {
  const claims = await requireAdmin();
  const { id } = z.object({ id: z.uuid() }).parse(Object.fromEntries(input));
  await revokeMcpToken(getDb(), claims.sub, id);
  revalidatePath("/settings");
}
