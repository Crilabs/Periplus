import { connection } from "next/server";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiError, apiNotFound } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { contentTypeOf } from "@/lib/domain/delivery/serialize";
import { cacheMaxAgeSeconds, deliveryArchive, isImageFile, packageFile, parseDataVersion } from "@/lib/domain/delivery/read";

type Ctx = RouteContext<"/api/v3/subdivisions/[subdivision]/package/images/[file]">;

/** One image file `images/<public id>-<slot>.jpg` of the current or `?dataVersion=` package, as stored (spec 13); like `package/[file]`. */
const handler = withApiClient<Ctx>("delivery:read", async (req, _client, ctx) => {
  const { subdivision, file: name } = await ctx.params;
  const file = `images/${name}`;
  if (!isImageFile(file)) return apiNotFound();
  const param = new URL(req.url).searchParams.get("dataVersion");
  const dataVersion = param === null ? undefined : parseDataVersion(param);
  if (dataVersion === null) return apiError(400, "invalid_data_version", "dataVersion must be a positive integer.");
  const found = await packageFile(getDb(), deliveryArchive(), subdivision, file, dataVersion);
  if (!found) return apiNotFound();
  return apiBody(req, found.bytes, {
    schemaVersion: found.schemaVersion,
    dataVersion: found.dataVersion,
    contentType: contentTypeOf(file),
    maxAgeSeconds: cacheMaxAgeSeconds(),
    sha256: found.sha256,
  });
});

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req, ctx);
}
