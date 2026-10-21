import type { NextRequest } from "next/server";
import { getArchive } from "@/lib/adapters/s3";
import { imageFileContentType } from "@/lib/domain/images/files";
import { adminSession, unauthorizedResponse } from "@/lib/security/require-admin";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * An image of the place image review from the archive (`?key=`): a render's photo or mask, a candidate, or an approved
 * image. Only keys `imageFileContentType` allows; any other key, or a missing object, is 404. Session required
 * (`adminSession` awaits `connection()`: never prerendered); never cached, never sniffed.
 */
export async function GET(request: NextRequest): Promise<Response> {
  if (!(await adminSession())) return unauthorizedResponse();
  const key = request.nextUrl.searchParams.get("key") ?? "";
  const contentType = imageFileContentType(key);
  const bytes = contentType ? await getArchive().get(key) : null;
  if (!contentType || !bytes) return Response.json({ error: { code: "not_found" } }, { status: 404, headers: NO_STORE });
  return new Response(new Uint8Array(bytes), {
    headers: { ...NO_STORE, "Content-Type": contentType, "X-Content-Type-Options": "nosniff" },
  });
}
