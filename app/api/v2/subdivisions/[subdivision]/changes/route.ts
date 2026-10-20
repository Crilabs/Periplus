import { connection } from "next/server";
import { SCHEMA_VERSION } from "@/contract";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiError, apiNotFound } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { cacheMaxAgeSeconds, changesSince, deliveryArchive, parseDataVersion, resolveSubdivision } from "@/lib/domain/delivery/read";

type Ctx = RouteContext<"/api/v2/subdivisions/[subdivision]/changes">;

const INVALID_SINCE = "since must be a data version from 1 up to the current one.";

/** The merged changes of the subdivision's packages after `?since=` (spec 08, spec 14 `GET /subdivisions/{subdivision}/changes`). */
const handler = withApiClient<Ctx>("delivery:read", async (req, _client, ctx) => {
  const since = parseDataVersion(new URL(req.url).searchParams.get("since"));
  if (since === null) return apiError(400, "invalid_since", INVALID_SINCE);
  const db = getDb();
  const subdivision = await resolveSubdivision(db, (await ctx.params).subdivision);
  if (!subdivision) return apiNotFound();
  const result = await changesSince(db, deliveryArchive(), subdivision.id, since);
  if (result === "not_found") return apiNotFound();
  if (result === "invalid_since") return apiError(400, "invalid_since", INVALID_SINCE);
  return apiBody(
    req,
    { schemaVersion: SCHEMA_VERSION, subdivision: subdivision.publicId, since, dataVersion: result.dataVersion, changes: result.changes },
    { schemaVersion: SCHEMA_VERSION, dataVersion: result.dataVersion, maxAgeSeconds: cacheMaxAgeSeconds() },
  );
});

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req, ctx);
}
