import { connection } from "next/server";
import { changesResponseSchema, SCHEMA_VERSION } from "@/contract";
import { withApiClient } from "@/lib/api/handler";
import { apiBody } from "@/lib/api/respond";
import { cacheMaxAgeSeconds } from "@/lib/domain/delivery/read";

type Ctx = RouteContext<"/api/v4/subdivisions/[subdivision]/changes">;

/** Contract 4.0 has no change feed: the consumer reloads the package (spec 14 `GET /subdivisions/{subdivision}/changes`, ruling E8). */
const handler = withApiClient<Ctx>("delivery:read", async (req) =>
  apiBody(req, changesResponseSchema.parse({ invalidSince: true, reason: "reload" }), {
    schemaVersion: SCHEMA_VERSION,
    dataVersion: null,
    maxAgeSeconds: cacheMaxAgeSeconds(),
  }),
);

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req, ctx);
}
