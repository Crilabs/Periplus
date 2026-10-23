import { describe, expect, it } from "vitest";
import { z } from "zod";
import { structuredOutputSchema } from "@/lib/ai/anthropic";
import { loadPrompt, renderPrompt } from "@/lib/ai/prompts";
import { bundleFactsTask } from "@/lib/ai/tasks/bundle-facts";
import { getConfig } from "@/lib/config";

describe("bundle-facts", () => {
  it("is configured and renders every variable of prompt v1, one line per fact", () => {
    expect(getConfig().models.tasks["bundle-facts"]).toMatchObject({ model: "claude-sonnet-5-5", promptVersion: 1, effort: "low", maxTokens: 8000 });
    const prompt = loadPrompt("bundle-facts", 1);
    const vars = bundleFactsTask.variables({
      facts: [
        { id: "f1", subject: "landside", subjectName: "Taverna Nikos", statement: "good\ntaverna", observedAt: "2019-07-01", tone: "positive" },
        { id: "f2", subject: "berth", subjectName: null, statement: "Quiet at night", observedAt: "2025-07-01", tone: null },
      ],
    });
    const user = renderPrompt(prompt.user, vars);
    expect(user).toContain("f1 | 2019-07-01 | positive | landside: Taverna Nikos | good taverna");
    expect(user).toContain("f2 | 2025-07-01 | no tone | the berth | Quiet at night");
    expect(() => renderPrompt(prompt.system, vars)).not.toThrow();
    for (const phrase of ["NEWER", "never write", "exactly once", "ALWAYS belong in one group", "open versus closed", "good taverna", "taverna closed", "do not contradict"]) expect(prompt.system.toLowerCase()).toContain(phrase.toLowerCase());
  });

  it("has an output schema structured outputs accept", () => {
    expect(() => structuredOutputSchema(z.toJSONSchema(bundleFactsTask.output))).not.toThrow();
  });
});
