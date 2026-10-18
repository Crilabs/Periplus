import { authenticateApiClient, type ApiClient, type ApiScope } from "@/lib/domain/api-clients";
import { getDb } from "@/lib/db/client";
import { createLogger } from "@/lib/logger";

export type LimitResult = { ok: true } | { ok: false; retryAfterMs: number };
type Limiter = (client: ApiClient) => Promise<LimitResult>;

// Seam: Task 10 replaces this with takeToken(db, "api:" + client.id, client.rateLimitPerMin).
let limiter: Limiter = async () => ({ ok: true });

export function setApiLimiter(next: Limiter): void {
  limiter = next;
}

function errorResponse(status: number, code: string, headers?: Record<string, string>): Response {
  return Response.json({ error: { code } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function withApiClient(
  scope: ApiScope,
  handler: (req: Request, client: ApiClient) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      const client = await authenticateApiClient(getDb(), req.headers.get("authorization"));
      if (!client) return errorResponse(401, "unauthorized", { "WWW-Authenticate": "Bearer" });
      if (!client.scopes.includes(scope)) return errorResponse(403, "forbidden");
      const limit = await limiter(client);
      if (!limit.ok) {
        return errorResponse(429, "rate_limited", {
          "Retry-After": String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))),
        });
      }
      const res = await handler(req, client);
      if (!res.headers.has("Cache-Control")) res.headers.set("Cache-Control", "no-store");
      return res;
    } catch (error) {
      createLogger("api").error(
        { err: error instanceof Error ? { name: error.name, message: error.message } : "unknown" },
        "unhandled error in api handler",
      );
      return errorResponse(500, "internal");
    }
  };
}
