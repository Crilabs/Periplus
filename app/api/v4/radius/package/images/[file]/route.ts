import { connection } from "next/server";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiError, apiNotFound } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { contentTypeOf } from "@/lib/domain/delivery/serialize";
import { cacheMaxAgeSeconds, deliveryArchive, isImageFile } from "@/lib/domain/delivery/read";
import { parseDays, radiusFile } from "@/lib/domain/delivery/radius/api";

type Ctx = RouteContext<"/api/v4/radius/package/images/[file]">;

/** One image `images/<file>` of the radius package `?key=` as stored; like `package/[file]`. */
const handler = withApiClient<Ctx>("delivery:read", async (req, client, ctx) => {
  const file = `images/${(await ctx.params).file}`;
  if (!isImageFile(file)) return apiNotFound();
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
