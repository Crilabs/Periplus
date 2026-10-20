import { connection } from "next/server";
import { SCHEMA_VERSION } from "@/contract";
import { withApiClient } from "@/lib/api/handler";
import { apiBody } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { cacheMaxAgeSeconds, listAreas } from "@/lib/domain/delivery/read";

/** Every area with its current data version (spec 08 `GET /areas`). */
const handler = withApiClient("delivery:read", async (req) => {
  const areas = await listAreas(getDb());
  return apiBody(req, { schemaVersion: SCHEMA_VERSION, areas }, { schemaVersion: SCHEMA_VERSION, dataVersion: null, maxAgeSeconds: cacheMaxAgeSeconds() });
});

export async function GET(req: Request): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req);
}
