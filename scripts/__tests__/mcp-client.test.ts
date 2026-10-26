import { describe, expect, it } from "vitest";
import { callMcpTool } from "../mcp-client";

/* The MCP client against a fake fetch that answers like `app/api/mcp/route.ts`. */

const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
const ok = (text: string, isError = false) => reply(200, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) } });

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
    await expect(callMcpTool({ url: "u", token: "t", fetch: ok("Unbekannter Landesteil", true) as unknown as typeof fetch }, "gate_input", {})).rejects.toThrow("Unbekannter Landesteil");
  });

  it("throws status and error field on a non-200 answer", async () => {
    await expect(callMcpTool({ url: "u", token: "t", fetch: reply(401, { error: "Token ungültig" }) as unknown as typeof fetch }, "version", {})).rejects.toThrow(/401.*Token ungültig/);
  });
});
