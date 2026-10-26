import { describe, expect, it } from "vitest";
import { callMcpTool } from "../mcp-client";

/* The MCP client against a fake fetch that answers like `app/api/mcp/route.ts`. */

const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
const ok = (text: string, isError = false) => reply(200, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) } });

const URL_OK = "https://x.invalid/api/mcp";

describe("callMcpTool", () => {
  it("posts one tools/call with the bearer token and parses the JSON text, unpacking untrusted envelopes", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return ok(JSON.stringify({ version: { gitSha: "abc" }, input: { hinweis: "Daten", nicht_vertrauenswuerdig: { n: 1 } } }))();
    }) as unknown as typeof fetch;
    const out = await callMcpTool({ url: "https://x.invalid/api/mcp", token: "tok", fetch: fetchFake }, "gate_input", { subdivision: "GR-I" });
    expect(out).toEqual({ version: { gitSha: "abc" }, input: { n: 1 } });
    expect(seen!.url).toBe("https://x.invalid/api/mcp");
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers.accept).toBe("application/json, text/event-stream");
    expect(JSON.parse(seen!.init.body as string)).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gate_input", arguments: { subdivision: "GR-I" } } });
  });

  it("throws the tool's text on isError", async () => {
    await expect(callMcpTool({ url: URL_OK, token: "t", fetch: ok("Unbekannter Landesteil", true) as unknown as typeof fetch }, "gate_input", {})).rejects.toThrow("Unbekannter Landesteil");
  });

  it("throws status and error field on a non-200 answer", async () => {
    await expect(callMcpTool({ url: URL_OK, token: "t", fetch: reply(401, { error: "Token ungültig" }) as unknown as typeof fetch }, "version", {})).rejects.toThrow(/401.*Token ungültig/);
  });

  it("refuses a URL without https unless it is localhost, before any request", async () => {
    let calls = 0;
    const fetchFake = (async () => {
      calls++;
      return ok("{}")();
    }) as unknown as typeof fetch;
    for (const url of ["http://periplus.example/api/mcp", "ftp://x/api/mcp", "kein url"]) {
      await expect(callMcpTool({ url, token: "t", fetch: fetchFake }, "version", {})).rejects.toThrow(/nur über https/);
    }
    expect(calls).toBe(0);
    for (const url of ["http://localhost:3000/api/mcp", "http://127.0.0.1:3000/api/mcp"]) {
      await expect(callMcpTool({ url, token: "t", fetch: fetchFake }, "version", {})).resolves.toEqual({});
    }
    expect(calls).toBe(2);
  });

  it("aborts a request after the timeout (120 s by default)", async () => {
    let signal: AbortSignal | undefined;
    const hanging = ((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    }) as unknown as typeof fetch;
    await expect(callMcpTool({ url: URL_OK, token: "t", fetch: hanging, timeoutMs: 20 }, "version", {})).rejects.toThrow(/Zeitlimit|timed out|timeout/i);
    expect(signal?.aborted).toBe(true);
  });
});
