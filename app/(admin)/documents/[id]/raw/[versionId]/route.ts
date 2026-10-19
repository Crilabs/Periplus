import type { NextRequest } from "next/server";
import { getArchive } from "@/lib/adapters/s3";
import { getDb } from "@/lib/db/client";
import { versionRawFile } from "@/lib/domain/document-view";
import { adminSession, unauthorizedResponse } from "@/lib/security/require-admin";

/**
 * The archived raw file of a document version, only ever as a download: crawled HTML must never run in the admin's
 * origin, so it is an attachment, sandboxed by CSP and never sniffed or cached. Session required.
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/documents/[id]/raw/[versionId]">): Promise<Response> {
  if (!(await adminSession())) return unauthorizedResponse();
  const { id, versionId } = await ctx.params;
  const file = await versionRawFile(getDb(), getArchive(), id, versionId);
  if (!file) {
    return Response.json({ error: { code: "not_found" } }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(Buffer.from(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
    },
  });
}
