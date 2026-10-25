import { connection } from "next/server";
import { SCHEMA_VERSION } from "@/contract/v3_0";
import { withApiClient } from "@/lib/api/handler";
import { apiBody } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { cacheMaxAgeSeconds, listSubdivisions } from "@/lib/domain/delivery/read";

/** Every active subdivision with its current data version (spec 08, spec 14 `GET /subdivisions`). */
const handler = withApiClient("delivery:read", async (req) => {
  const subdivisions = await listSubdivisions(getDb());
  return apiBody(req, { schemaVersion: SCHEMA_VERSION, subdivisions }, { schemaVersion: SCHEMA_VERSION, dataVersion: null, maxAgeSeconds: cacheMaxAgeSeconds() });
});

export async function GET(req: Request): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req);
}
