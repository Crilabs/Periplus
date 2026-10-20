import { connection } from "next/server";
import { contractJsonSchema } from "@/contract";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiNotFound } from "@/lib/api/respond";
import { cacheMaxAgeSeconds } from "@/lib/domain/delivery/read";

type Ctx = RouteContext<"/api/v1/schema/[version]/[file]">;

/** The JSON schema of a contract file (spec 08 `GET /schema/{version}/{file}`, e.g. `1.0/spots.schema.json`). */
const handler = withApiClient<Ctx>("delivery:read", async (req, _client, ctx) => {
  const { version, file } = await ctx.params;
  const schema = contractJsonSchema(version, file);
  if (!schema) return apiNotFound();
  return apiBody(req, schema, { schemaVersion: version, dataVersion: null, maxAgeSeconds: cacheMaxAgeSeconds() });
});

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req, ctx);
}
