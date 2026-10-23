import { connection } from "next/server";
import { SCHEMA_VERSION } from "@/contract";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiError, apiNotFound } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { cacheMaxAgeSeconds, deliveryArchive } from "@/lib/domain/delivery/read";
import { parseDays } from "@/lib/domain/delivery/radius/api";
import { radiusChangesSince } from "@/lib/domain/delivery/radius/changes";

/** The changes after the radius package `?since=` (a package key) for the same marina and days (spec 18, spec 14 `GET /radius/changes`). */
const handler = withApiClient("delivery:read", async (req, client) => {
  const params = new URL(req.url).searchParams;
  const marina = params.get("marina");
  if (!marina) return apiError(400, "invalid_parameter", "marina is required.");
  const since = params.get("since");
  if (!since) return apiError(400, "invalid_since", "since must be the key of an earlier package for this marina and days.");
  const result = await radiusChangesSince(getDb(), deliveryArchive(), { marina, days: parseDays(params.get("days")), since, apiClientId: client.id });
  if (result === "invalid_days") return apiError(400, "invalid_days", "days must be an integer from 1 to 28.");
  if (result === "invalid_since") return apiError(400, "invalid_since", "since must be the key of an earlier package for this marina and days.");
  if (result === "marina_not_found") return apiNotFound();
  return apiBody(req, { schemaVersion: SCHEMA_VERSION, since, key: result.key, changes: result.changes }, { schemaVersion: SCHEMA_VERSION, dataVersion: null, maxAgeSeconds: cacheMaxAgeSeconds() });
});

export async function GET(req: Request): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req);
}
