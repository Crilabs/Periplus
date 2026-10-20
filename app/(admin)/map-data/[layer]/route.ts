import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { mapDataRequest, mapLayer } from "@/lib/domain/map-data";
import { adminSession, unauthorizedResponse } from "@/lib/security/require-admin";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GeoJSON of one map layer within `?bbox=w,s,e,n` (at most 5° × 5°), the geo-object layer only of `?types=` when given,
 * with `truncated` when the cap cut it. Session required; never cached.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/map-data/[layer]">): Promise<Response> {
  if (!(await adminSession())) return unauthorizedResponse();
  const parsed = mapDataRequest.safeParse({
    layer: (await ctx.params).layer,
    bbox: request.nextUrl.searchParams.get("bbox"),
    types: request.nextUrl.searchParams.get("types") ?? undefined,
  });
  if (!parsed.success) return Response.json({ error: { code: "bad_request" } }, { status: 400, headers: NO_STORE });
  const features = await mapLayer(getDb(), parsed.data.layer, parsed.data.bbox, { types: parsed.data.types });
  return new Response(JSON.stringify(features), {
    headers: { ...NO_STORE, "Content-Type": "application/geo+json" },
  });
}
