"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { revokeApiClient } from "@/lib/domain/api-clients";
import { requireAdmin } from "@/lib/security/require-admin";

const revokeSchema = z.object({ id: z.uuid() });

const fields = (input: FormData | object) => (input instanceof FormData ? Object.fromEntries(input) : input);

/** „Sperren“ of an API client on `/settings`: its key fails from now on. Creating clients stays on the CLI. */
export async function revokeApiClientAction(input: FormData | { id: string }): Promise<void> {
  await requireAdmin();
  const { id } = revokeSchema.parse(fields(input));
  await revokeApiClient(getDb(), id);
  revalidatePath("/settings");
  redirect("/settings?notice=api_client_revoked#api-clients");
}
