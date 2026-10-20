import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { deliveryArchive } from "@/lib/domain/delivery/archive";
import { isImageFile } from "@/lib/domain/delivery/read";
import { deliveryDownload } from "@/lib/domain/delivery/view";
import { adminSession, unauthorizedResponse } from "@/lib/security/require-admin";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** One image file `images/<public id>-<slot>.jpg` of a package as a download, like `files/[file]` (spec 13). */
export async function GET(_request: NextRequest, ctx: RouteContext<"/deliveries/[id]/files/images/[file]">): Promise<Response> {
  if (!(await adminSession())) return unauthorizedResponse();
  const { id, file: name } = await ctx.params;
  const file = `images/${name}`;
  const found = z.uuid().safeParse(id).success && isImageFile(file) ? await deliveryDownload(getDb(), deliveryArchive(), id, file) : null;
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
