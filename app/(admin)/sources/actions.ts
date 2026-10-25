"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { DOC_TYPES } from "@/lib/db/schema";
import { ForbiddenSourceDomain } from "@/lib/domain/sources/forbidden-domains";
import { createManualSource, InvalidSourceDomain, SourceDomainKnown } from "@/lib/domain/sources/store";
import { requireAdmin } from "@/lib/security/require-admin";

const fields = (input: FormData | object) => (input instanceof FormData ? Object.fromEntries(input) : input);

const newSourceSchema = z.object({
  domain: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(200),
  type: z.enum(DOC_TYPES),
});

/**
 * "Neue Quelle": an approved manual source for the registrable domain; a known or forbidden domain comes back with an
 * error.
 */
export async function createSourceAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const parsed = newSourceSchema.safeParse(fields(formData));
  if (!parsed.success) return redirect("/sources?error=invalid_source");
  let target: string;
  try {
    const { id } = await createManualSource(getDb(), parsed.data);
    target = `/sources/${id}`;
  } catch (e) {
    if (e instanceof SourceDomainKnown) target = "/sources?error=domain_known";
    else if (e instanceof InvalidSourceDomain) target = "/sources?error=invalid_domain";
    else if (e instanceof ForbiddenSourceDomain) target = "/sources?error=forbidden_domain";
    else throw e;
  }
  revalidatePath("/sources");
  redirect(target);
}
