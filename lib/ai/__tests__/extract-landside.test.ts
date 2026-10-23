import { describe, expect, it } from "vitest";
import { structuredOutputSchema } from "@/lib/ai/anthropic";
import { loadPrompt, renderPrompt } from "@/lib/ai/prompts";
import { extractLandsideTask, type ExtractLandsideInput } from "@/lib/ai/tasks/extract-landside";

const input: ExtractLandsideInput = {
  place: "Vathi",
  subjects: ["Kato Limani", "Katw Limani"],
  pageKind: "trip_report",
  observedAt: "2024-06-15",
  text: "In Kato Limani, Taverna Kyma is open.",
  limits: { quoteMinChars: 12, quoteMaxChars: 300 },
};

describe("extract-landside", () => {
  it("renders every variable of prompt v1; the page-specific part stays in the user prompt", () => {
    const prompt = loadPrompt("extract-landside", 1);
    const vars = extractLandsideTask.variables(input);
    const system = renderPrompt(prompt.system, vars);
    const user = renderPrompt(prompt.user, vars);
    expect(system).toContain("at most 300 characters");
    expect(system).not.toContain("Searched for");
    expect(system).not.toContain("Vathi");
    expect(user).toContain("Berth (orientation only): Vathi");
    expect(user).toContain("Searched for: Kato Limani, Katw Limani");
    expect(user).toContain("In Kato Limani, Taverna Kyma is open.");
  });

  it("the prompt keeps boats out: nothing about anchoring or mooring, an empty list is a good answer", () => {
    const { system } = loadPrompt("extract-landside", 1);
    expect(system).toMatch(/never extract anything about anchoring, mooring/);
    expect(system).toContain("An empty list is a good answer");
  });

  it("the output has facts only: no core value, signal or landing hint to offer", () => {
    const ok = { facts: [{ subject_name: null, subject_category: "beach", statement: "s", quote: "q", observed_at: null, tone: "neutral", safety: false }] };
    expect(extractLandsideTask.output.safeParse(ok).success).toBe(true);
    expect(Object.keys((extractLandsideTask.output as unknown as { shape: object }).shape)).toEqual(["facts"]);
    expect(extractLandsideTask.output.safeParse({ facts: [{ ...ok.facts[0], subject_category: null }] }).success).toBe(false);
    expect(() => structuredOutputSchema(extractLandsideTask.output)).not.toThrow();
  });
});
