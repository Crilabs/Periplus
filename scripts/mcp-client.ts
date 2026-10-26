/** A minimal client of the production MCP endpoint: one stateless JSON-RPC `tools/call` per request. */

/** `timeoutMs`: how long one call may take (default 120 s; a start tool's preview counts candidates on the server). */
export type McpOptions = { url: string; token: string; fetch?: typeof fetch; timeoutMs?: number };

const DEFAULT_TIMEOUT_MS = 120_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** The token goes only over https; plain http only to this machine (a local dev server). */
function checkedUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MCP-URL ungültig: nur über https (http nur für localhost oder 127.0.0.1)");
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) return raw;
  throw new Error(`MCP-URL ${url.protocol}//${url.host} abgelehnt: nur über https (http nur für localhost oder 127.0.0.1)`);
}

/** Calls one tool of the MCP server; returns the parsed JSON text with the `nicht_vertrauenswuerdig` envelopes unpacked. */
export async function callMcpTool(opts: McpOptions, name: string, args: object): Promise<unknown> {
  const url = checkedUrl(opts.url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") throw new Error(`MCP: keine Antwort nach ${timeoutMs / 1000} s (Zeitlimit)`);
    throw e;
  }
  if (res.status !== 200) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(`MCP ${res.status}: ${typeof body?.error === "string" ? body.error : "no error text"}`);
  }
  const body = (await res.json()) as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } };
  if (body.error) throw new Error(`MCP: ${body.error.message ?? "protocol error"}`);
  const text = body.result?.content?.[0]?.text;
  if (text === undefined) throw new Error("MCP: empty tool result");
  if (body.result?.isError) throw new Error(text);
  return unwrapUntrusted(JSON.parse(text));
}

/** Replaces every `{ hinweis, nicht_vertrauenswuerdig }` envelope by its content; the content stays data, never instructions. */
function unwrapUntrusted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrapUntrusted);
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if ("nicht_vertrauenswuerdig" in obj && typeof obj.hinweis === "string") return unwrapUntrusted(obj.nicht_vertrauenswuerdig);
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, unwrapUntrusted(v)]));
}
