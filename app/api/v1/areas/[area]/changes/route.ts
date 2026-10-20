import { connection } from "next/server";
import { SCHEMA_VERSION } from "@/contract";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiError, apiNotFound } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { cacheMaxAgeSeconds, changesSince, deliveryArchive, parseSince, resolveArea } from "@/lib/domain/delivery/read";

type Ctx = RouteContext<"/api/v1/areas/[area]/changes">;

const INVALID_SINCE = "since must be a data version from 1 up to the current one.";

/** The merged changes of the area's packages after `?since=` (spec 08 `GET /areas/{area}/changes`). */
const handler = withApiClient<Ctx>("delivery:read", async (req, _client, ctx) => {
  const since = parseSince(new URL(req.url).searchParams.get("since"));
  if (since === null) return apiError(400, "invalid_since", INVALID_SINCE);
  const db = getDb();
  const area = await resolveArea(db, (await ctx.params).area);
  if (!area) return apiNotFound();
  const result = await changesSince(db, deliveryArchive(), area.geoObjectId, since);
  if (result === "not_found") return apiNotFound();
  if (result === "invalid_since") return apiError(400, "invalid_since", INVALID_SINCE);
  return apiBody(
    req,
    { schemaVersion: SCHEMA_VERSION, area: area.publicId, since, dataVersion: result.dataVersion, changes: result.changes },
    { schemaVersion: SCHEMA_VERSION, dataVersion: result.dataVersion, maxAgeSeconds: cacheMaxAgeSeconds() },
  );
});

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req, ctx);
}
