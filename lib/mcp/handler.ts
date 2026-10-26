import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getDb } from "@/lib/db/client";
import { resolveMcpToken } from "@/lib/domain/mcp-tokens";
import { takeToken } from "@/lib/domain/rate-limit";
import { createLogger } from "@/lib/logger";
import { createPeriplusMcpServer } from "./server";

/*
 * `POST /api/mcp` (plan 2026-10-26-periplus-mcp, after SITA `src/server/mcp/handler.ts`): stateless Streamable HTTP
 * with JSON answers, a fresh server per request. A request with an Origin header (a browser) is refused (DNS
 * rebinding); every token failure gets the same 401; 120 requests a minute per token.
 */

export const MCP_RATE_PER_MINUTE = 120;
const MAX_BODY_BYTES = 256 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };
export const UNAUTHORIZED_MESSAGE =
  "Token fehlt, ist abgelaufen oder widerrufen. Neues Token unter Einstellungen → Claude Code (MCP) anlegen.";

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

type Limiter = (tokenId: string) => Promise<{ ok: boolean; retryAfterMs?: number }>;
const defaultLimiter: Limiter = (tokenId) => takeToken(getDb(), "mcp:" + tokenId, MCP_RATE_PER_MINUTE);
let limiter: Limiter = defaultLimiter;

/** Test seam; null restores the Postgres token bucket. */
export function setMcpLimiter(next: Limiter | null): void {
  limiter = next ?? defaultLimiter;
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  const started = Date.now();
  const log = createLogger("mcp");
  try {
    if (request.headers.has("origin")) return json({ error: "Browser-Anfragen sind nicht erlaubt." }, 403);
    const caller = await resolveMcpToken(getDb(), request.headers.get("authorization"));
    if (!caller) return json({ error: UNAUTHORIZED_MESSAGE }, 401, { "WWW-Authenticate": 'Bearer realm="periplus"' });
    const limit = await limiter(caller.tokenId);
    if (!limit.ok) {
      return json({ error: "Zu viele Anfragen." }, 429, { "Retry-After": String(Math.max(1, Math.ceil((limit.retryAfterMs ?? 1000) / 1000))) });
    }
    const server = createPeriplusMcpServer(caller);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, headers });
    } finally {
      await server.close();
    }
  } catch (error) {
    log.error({ err: error instanceof Error ? error.name : "unknown", ms: Date.now() - started }, "mcp request failed");
    return json({ error: "Interner Fehler." }, 500);
  }
}

/** GET and DELETE: no SSE stream and no sessions in the stateless server. */
export function methodNotAllowed(): Response {
  return json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405, { Allow: "POST" });
}
