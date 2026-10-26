import { connection } from "next/server";
import { changesResponseSchema, SCHEMA_VERSION } from "@/contract";
import { withApiClient } from "@/lib/api/handler";
import { apiBody } from "@/lib/api/respond";
import { cacheMaxAgeSeconds } from "@/lib/domain/delivery/read";

/** Contract 4.0 has no change feed: the consumer reloads the package (spec 14 `GET /radius/changes`, ruling E8). */
const handler = withApiClient("delivery:read", async (req) =>
  apiBody(req, changesResponseSchema.parse({ invalidSince: true, reason: "reload" }), {
    schemaVersion: SCHEMA_VERSION,
    dataVersion: null,
    maxAgeSeconds: cacheMaxAgeSeconds(),
  }),
);

export async function GET(req: Request): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req);
}
