import { connection } from "next/server";
import { publishedJsonSchema } from "@/contract/schema/published";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiNotFound } from "@/lib/api/respond";
import { cacheMaxAgeSeconds } from "@/lib/domain/delivery/read";

type Ctx = RouteContext<"/api/v4/schema/[version]/[file]">;

/** The JSON schema of a contract file (spec 08 `GET /schema/{version}/{file}`, e.g. `2.0/spots.schema.json`), of every published version. */
const handler = withApiClient<Ctx>("delivery:read", async (req, _client, ctx) => {
  const { version, file } = await ctx.params;
  const schema = publishedJsonSchema(version, file);
  if (!schema) return apiNotFound();
  return apiBody(req, schema, { schemaVersion: version, dataVersion: null, maxAgeSeconds: cacheMaxAgeSeconds() });
});

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req, ctx);
}
