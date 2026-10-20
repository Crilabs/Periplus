import { connection } from "next/server";
import { SCHEMA_VERSION } from "@/contract";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiError, apiNotFound } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { cacheMaxAgeSeconds, currentPackage, deliveryArchive } from "@/lib/domain/delivery/read";

type Ctx = RouteContext<"/api/v1/areas/[area]/package">;

/** The area's current manifest with links to its files (spec 08 `GET /areas/{area}/package`). */
const handler = withApiClient<Ctx>("delivery:read", async (req, _client, ctx) => {
  // the manifest of an older package is its file: never answer the current one to a pinned request
  if (new URL(req.url).searchParams.has("dataVersion")) {
    return apiError(400, "invalid_parameter", "dataVersion is not supported here; use /package/manifest.json?dataVersion=<n>.");
  }
  const pkg = await currentPackage(getDb(), deliveryArchive(), (await ctx.params).area);
  if (!pkg) return apiNotFound();
  return apiBody(req, pkg.body, { schemaVersion: SCHEMA_VERSION, dataVersion: pkg.dataVersion, maxAgeSeconds: cacheMaxAgeSeconds() });
});

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req, ctx);
}
