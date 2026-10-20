import { connection } from "next/server";
import { SCHEMA_VERSION } from "@/contract";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiError, apiNotFound } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { contentTypeOf } from "@/lib/domain/delivery/serialize";
import { cacheMaxAgeSeconds, deliveryArchive, isContractFile, packageFile, parseDataVersion } from "@/lib/domain/delivery/read";

type Ctx = RouteContext<"/api/v1/areas/[area]/package/[file]">;

/** One package file as stored, of the current or `?dataVersion=` package (spec 08). */
const handler = withApiClient<Ctx>("delivery:read", async (req, _client, ctx) => {
  const { area, file } = await ctx.params;
  if (!isContractFile(file)) return apiNotFound();
  const param = new URL(req.url).searchParams.get("dataVersion");
  const dataVersion = param === null ? undefined : parseDataVersion(param);
  if (dataVersion === null) return apiError(400, "invalid_data_version", "dataVersion must be a positive integer.");
  const found = await packageFile(getDb(), deliveryArchive(), area, file, dataVersion);
  if (!found) return apiNotFound();
  return apiBody(req, found.bytes, {
    schemaVersion: SCHEMA_VERSION,
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
