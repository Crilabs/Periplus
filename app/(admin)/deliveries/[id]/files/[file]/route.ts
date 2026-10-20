import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { deliveryArchive } from "@/lib/domain/delivery/archive";
import { isContractFile } from "@/lib/domain/delivery/read";
import { deliveryDownload } from "@/lib/domain/delivery/view";
import { adminSession, unauthorizedResponse } from "@/lib/security/require-admin";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * One stored file of a package as a download, a rejected package's too (diagnosis; the API never serves those).
 * Session required (`adminSession` awaits `connection()`: never prerendered); never cached.
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/deliveries/[id]/files/[file]">): Promise<Response> {
  if (!(await adminSession())) return unauthorizedResponse();
  const { id, file } = await ctx.params;
  const found = z.uuid().safeParse(id).success && isContractFile(file) ? await deliveryDownload(getDb(), deliveryArchive(), id, file) : null;
  if (!found) return Response.json({ error: { code: "not_found" } }, { status: 404, headers: NO_STORE });
  return new Response(new Uint8Array(found.bytes), {
    headers: {
      ...NO_STORE,
      "Content-Type": found.contentType,
      "Content-Disposition": `attachment; filename="${found.filename}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
