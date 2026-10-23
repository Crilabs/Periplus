import { connection } from "next/server";
import { SCHEMA_VERSION } from "@/contract";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiError } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { cacheMaxAgeSeconds, deliveryArchive } from "@/lib/domain/delivery/read";
import { listHomeMarinas, parseBbox } from "@/lib/domain/delivery/radius/home-marinas";

/** The marinas a radius package can be built around, optionally inside `?bbox=w,s,e,n` (spec 18, spec 14 `GET /home-marinas`). */
const handler = withApiClient("delivery:read", async (req) => {
  const param = new URL(req.url).searchParams.get("bbox");
  const bbox = param === null ? undefined : parseBbox(param);
  if (bbox === null) return apiError(400, "invalid_bbox", "bbox must be west,south,east,north in degrees.");
  const marinas = await listHomeMarinas(getDb(), deliveryArchive(), bbox);
  return apiBody(req, { schemaVersion: SCHEMA_VERSION, marinas }, { schemaVersion: SCHEMA_VERSION, dataVersion: null, maxAgeSeconds: cacheMaxAgeSeconds() });
});

export async function GET(req: Request): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req);
}
