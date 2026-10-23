import { connection } from "next/server";
import { SCHEMA_VERSION } from "@/contract";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiError, apiNotFound } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { cacheMaxAgeSeconds, deliveryArchive, isCalendarDate, isSpotId, spotAsOf } from "@/lib/domain/delivery/read";

type Ctx = RouteContext<"/api/v3/spots/[id]">;

/**
 * A spot as delivered on `?asOf=YYYY-MM-DD`, without it the latest delivered version (spec 08 `GET /spots/{id}`), with
 * the subdivision and data version of the package that introduced that version.
 */
const handler = withApiClient<Ctx>("delivery:read", async (req, _client, ctx) => {
  const { id } = await ctx.params;
  if (!isSpotId(id)) return apiNotFound();
  const asOf = new URL(req.url).searchParams.get("asOf");
  if (asOf !== null && !isCalendarDate(asOf)) return apiError(400, "invalid_date", "asOf must be a calendar date YYYY-MM-DD.");
  const found = await spotAsOf(getDb(), deliveryArchive(), id, asOf ?? undefined);
  if (!found) return apiNotFound();
  return apiBody(
    req,
    // dataVersion counts per subdivision: the subdivision whose package introduced this spot version
    { schemaVersion: SCHEMA_VERSION, subdivision: found.subdivision, dataVersion: found.dataVersion, spot: found.spot },
    { schemaVersion: SCHEMA_VERSION, dataVersion: found.dataVersion, maxAgeSeconds: cacheMaxAgeSeconds() },
  );
});

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req, ctx);
}
