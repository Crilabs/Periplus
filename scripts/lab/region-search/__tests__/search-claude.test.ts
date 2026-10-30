import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { parseSearchMessage, searchCostEur } from "../search-claude";

const message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  stop_reason: "end_turn",
  stop_sequence: null,
  content: [
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Alpha Island anchorages" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [
        { type: "web_search_result", url: "https://example.org/alpha-anchorages", title: "Alpha anchorages", encrypted_content: "x", page_age: null },
        { type: "web_search_result", url: "https://example.net/blog/alpha", title: "Our week at Alpha", encrypted_content: "y", page_age: "2024-05-01" },
      ],
    },
    { type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: { query: "Alpha Island Ankerplätze" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
    { type: "text", text: 'Found two pages.\n\n```json\n{"urls": ["https://example.org/alpha-anchorages"]}\n```\n' },
  ],
  usage: { input_tokens: 100000, output_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 8 } },
} as unknown as Anthropic.Message;

describe("parseSearchMessage", () => {
  it("collects queries, results and the model's chosen URLs; an error result adds nothing", () => {
    const parsed = parseSearchMessage(message);
    expect(parsed.queries).toEqual(["Alpha Island anchorages", "Alpha Island Ankerplätze"]);
    expect(parsed.results.map((r) => r.url)).toEqual(["https://example.org/alpha-anchorages", "https://example.net/blog/alpha"]);
    expect(parsed.results[1]?.title).toBe("Our week at Alpha");
    expect(parsed.chosen).toEqual(["https://example.org/alpha-anchorages"]);
  });

  it("returns no chosen URLs when the text has no valid JSON block", () => {
    const broken = { ...message, content: [{ type: "text", text: "no json here" }] } as unknown as Anthropic.Message;
    expect(parseSearchMessage(broken).chosen).toEqual([]);
  });
});

describe("searchCostEur", () => {
  it("prices tokens at Sonnet 5.5 rates plus the searches", () => {
    // 100k × 2 $/M + 2k × 10 $/M + 8 × 0.01 $ = 0.20 + 0.02 + 0.08 = 0.30 $ ≈ 0.276 €
    expect(searchCostEur(message.usage)).toBeCloseTo(0.276, 2);
  });
});
