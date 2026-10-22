import { describe, expect, it } from "vitest";
import { loadPrompt, renderPrompt } from "@/lib/ai/prompts";
import { extractFactsTask, type ExtractFactsInput } from "@/lib/ai/tasks/extract-facts";
import { getConfig } from "@/lib/config";

const input = (boundToWebsite: boolean): ExtractFactsInput => ({
  level: "place",
  factSchemaVersion: "v3",
  maxFacts: 20,
  limits: { quoteMinChars: 10, quoteMaxChars: 300, nameMaxChars: 80 },
  object: { name: "Marina Kolona", type: "harbour", parents: [] },
  docType: "marina",
  observedAt: "2026-10-22",
  chunks: [{ n: 1, text: "Our marina has diesel." }],
  boundToWebsite,
});

describe("extract-facts prompt v6", () => {
  it("is the configured prompt version", () => {
    expect(getConfig().models.tasks["extract-facts"].promptVersion).toBe(6);
  });

  it("states the bound note only when the text is the object's own website", () => {
    const prompt = loadPrompt("extract-facts", 6);
    const on = renderPrompt(prompt.system, extractFactsTask.variables(input(true)));
    const off = renderPrompt(prompt.system, extractFactsTask.variables(input(false)));
    expect(on).toContain(`This text is the object's own website: statements about "our marina", "the marina" or "the harbour" are about the object.`);
    expect(off).not.toContain("own website");
    expect(off).not.toContain("{{");
    expect(on).toContain("Only facts about the named object");
  });
});
