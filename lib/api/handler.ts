import { authenticateApiClient, type ApiClient, type ApiScope } from "@/lib/domain/api-clients";
import { getDb } from "@/lib/db/client";
import { takeToken } from "@/lib/domain/rate-limit";
import { createLogger } from "@/lib/logger";
import { API_MESSAGES, apiError } from "./respond";

export type LimitResult = { ok: true } | { ok: false; retryAfterMs: number };
type Limiter = (client: ApiClient) => Promise<LimitResult>;

const defaultLimiter: Limiter = (client) => takeToken(getDb(), "api:" + client.id, client.rateLimitPerMin);
let limiter: Limiter = defaultLimiter;

/** Test seam; pass null to restore the Postgres token bucket. */
export function setApiLimiter(next: Limiter | null): void {
  limiter = next ?? defaultLimiter;
}

/** The route context argument: optional for routes without one (`C = undefined`, the ping route). */
type ContextArgs<C> = undefined extends C ? [ctx?: C] : [ctx: C];

/**
 * Wraps a route handler with API key authentication (`Authorization: Bearer pk_…`), the scope check and the client's
 * rate limit; passes the route context through. Errors use the API error format with fixed messages; a thrown error
 * is logged and answered as 500 without details.
 */
export function withApiClient<C = undefined>(
  scope: ApiScope,
  handler: (req: Request, client: ApiClient, ctx: C) => Promise<Response>,
): (req: Request, ...ctx: ContextArgs<C>) => Promise<Response> {
  return async (req, ...rest) => {
    try {
      const client = await authenticateApiClient(getDb(), req.headers.get("authorization"));
      if (!client) return apiError(401, "unauthorized", API_MESSAGES.unauthorized, { "WWW-Authenticate": "Bearer" });
      if (!client.scopes.includes(scope)) return apiError(403, "forbidden", API_MESSAGES.forbidden);
      const limit = await limiter(client);
      if (!limit.ok) {
        return apiError(429, "rate_limited", API_MESSAGES.rate_limited, {
          "Retry-After": String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))),
        });
      }
      const res = await handler(req, client, rest[0] as C);
      if (!res.headers.has("Cache-Control")) res.headers.set("Cache-Control", "no-store");
      return res;
    } catch (error) {
      createLogger("api").error(
        { err: error instanceof Error ? { name: error.name, message: error.message } : "unknown" },
        "unhandled error in api handler",
      );
      return apiError(500, "internal", API_MESSAGES.internal);
    }
  };
}
