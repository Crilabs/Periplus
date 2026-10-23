"use server";

import { zipSync } from "fflate";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { deliveryArchive } from "@/lib/domain/delivery/archive";
import { readRadiusFile } from "@/lib/domain/delivery/radius/build";
import { previewRadius } from "@/lib/domain/delivery/radius/view";
import { requireAdmin } from "@/lib/security/require-admin";

const inputSchema = z.object({ marina: z.string().min(1), days: z.number().int() });

/**
 * „Als ZIP laden“: every stored file of the radius package for `marina` and `days` (built first if not yet cached) as
 * one ZIP, for the check before the first client. Admin session required; the error codes of `previewRadius` otherwise.
 */
export async function downloadRadiusZip(
  marina: string,
  days: number,
): Promise<{ filename: string; zip: Uint8Array } | "marina_not_found" | "invalid_days"> {
  await requireAdmin();
  const input = inputSchema.safeParse({ marina, days });
  if (!input.success) return "invalid_days";
  const archive = deliveryArchive();
  const preview = await previewRadius(getDb(), archive, input.data.marina, input.data.days);
  if (typeof preview === "string") return preview;
  const files: Record<string, Uint8Array> = {};
  for (const name of Object.keys(preview.row.fileHashes)) {
    const bytes = await readRadiusFile(archive, preview.row, name);
    if (bytes === null) throw new Error(`radius package ${preview.row.key} lost its file ${name}`);
    files[name] = bytes;
  }
  return { filename: `radius-${marina}-${days}d.zip`, zip: zipSync(files, { level: 0 }) };
}
