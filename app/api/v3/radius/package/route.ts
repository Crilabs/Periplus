import { connection } from "next/server";
import { withApiClient } from "@/lib/api/handler";
import { apiBody, apiError, apiNotFound } from "@/lib/api/respond";
import { getDb } from "@/lib/db/client";
import { cacheMaxAgeSeconds, deliveryArchive } from "@/lib/domain/delivery/read";
import { radiusManifest, parseDays } from "@/lib/domain/delivery/radius/api";
import { getRadiusPackage } from "@/lib/domain/delivery/radius/build";

/** The radius package's manifest with links to its files, pinned to its key (spec 18, spec 14 `GET /radius/package`). */
const handler = withApiClient("delivery:read", async (req, client) => {
  const params = new URL(req.url).searchParams;
  const marina = params.get("marina");
  if (!marina) return apiError(400, "invalid_parameter", "marina is required.");
  const archive = deliveryArchive();
  const row = await getRadiusPackage(getDb(), archive, { marina, days: parseDays(params.get("days")), apiClientId: client.id, kind: "package" });
  if (row === "invalid_days") return apiError(400, "invalid_days", "days must be an integer from 1 to 28.");
  if (row === "marina_not_found") return apiNotFound();
  return apiBody(req, await radiusManifest(archive, row), { schemaVersion: row.schemaVersion, dataVersion: null, maxAgeSeconds: cacheMaxAgeSeconds() });
});

export async function GET(req: Request): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req);
}
