import { connection } from "next/server";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiError, apiNotFound } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { contentTypeOf } from "@/lib/domain/delivery/serialize";
import { cacheMaxAgeSeconds, deliveryArchive, isContractFile } from "@/lib/domain/delivery/read";
import { parseDays, radiusFile } from "@/lib/domain/delivery/radius/api";

type Ctx = RouteContext<"/api/v3/radius/package/[file]">;

/** One file of the radius package `?key=` as stored (spec 18, spec 14 `GET /radius/package/{file}`). */
const handler = withApiClient<Ctx>("delivery:read", async (req, client, ctx) => {
  const { file } = await ctx.params;
  if (!isContractFile(file)) return apiNotFound();
  const params = new URL(req.url).searchParams;
  const marina = params.get("marina");
  if (!marina) return apiError(400, "invalid_parameter", "marina is required.");
  const found = await radiusFile(getDb(), deliveryArchive(), { marina, days: parseDays(params.get("days")), key: params.get("key"), file, apiClientId: client.id });
  if (found === "invalid_key") return apiError(400, "invalid_key", "key must be the key of a package for this marina and days.");
  if (found === null) return apiNotFound();
  return apiBody(req, found.bytes, { schemaVersion: found.schemaVersion, dataVersion: null, contentType: contentTypeOf(file), maxAgeSeconds: cacheMaxAgeSeconds(), sha256: found.sha256 });
});

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req, ctx);
}
