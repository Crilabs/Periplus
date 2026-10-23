import { connection } from "next/server";
import { withApiClient } from "@/lib/api/handler";

const handler = withApiClient("delivery:read", async (_req, client) => Response.json({ ok: true, client: client.name }));

export async function GET(req: Request): Promise<Response> {
  await connection(); // authenticated per request: never prerender (cacheComponents)
  return handler(req);
}
