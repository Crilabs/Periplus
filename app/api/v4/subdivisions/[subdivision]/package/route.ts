import { connection } from "next/server";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiError, apiNotFound } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { cacheMaxAgeSeconds, currentPackage, deliveryArchive } from "@/lib/domain/delivery/read";

type Ctx = RouteContext<"/api/v4/subdivisions/[subdivision]/package">;

/** The subdivision's current manifest with links to its files (spec 08, spec 14 `GET /subdivisions/{subdivision}/package`). */
const handler = withApiClient<Ctx>("delivery:read", async (req, _client, ctx) => {
  // the manifest of an older package is its file: never answer the current one to a pinned request
  if (new URL(req.url).searchParams.has("dataVersion")) {
    return apiError(400, "invalid_parameter", "dataVersion is not supported here; use /package/manifest.json?dataVersion=<n>.");
  }
  const pkg = await currentPackage(getDb(), deliveryArchive(), (await ctx.params).subdivision);
  if (!pkg) return apiNotFound();
  return apiBody(req, pkg.body, { schemaVersion: pkg.schemaVersion, dataVersion: pkg.dataVersion, maxAgeSeconds: cacheMaxAgeSeconds() });
});

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req, ctx);
}
