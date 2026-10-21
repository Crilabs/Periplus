import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { areaDetail } from "@/lib/domain/areas/view";
import { adminSession, unauthorizedResponse } from "@/lib/security/require-admin";

const NO_STORE = { "Cache-Control": "no-store" };

/** The detail of one valid Revier for the map panel (JSON, `areaDetail`); 404 for an unknown or ended one. Session required; never cached. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/map/area-detail/[id]">): Promise<Response> {
  if (!(await adminSession())) return unauthorizedResponse();
  const detail = await areaDetail(getDb(), (await ctx.params).id);
  if (!detail) return Response.json({ error: { code: "not_found" } }, { status: 404, headers: NO_STORE });
  return Response.json(detail, { headers: NO_STORE });
}
