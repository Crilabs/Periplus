import { describe, expect, it } from "vitest";
import { z } from "zod";
import { structuredOutputSchema } from "@/lib/ai/anthropic";
import { loadPrompt, renderPrompt } from "@/lib/ai/prompts";
import { berthLine, extractBerthTask, type ExtractBerthInput } from "@/lib/ai/tasks/extract-berth";
import { berthAttributes } from "@/lib/domain/research/extraction";

const input: ExtractBerthInput = {
  berth: { name: "Vathi", names: ["Vathi", "Ormos Vathi"], kind: "anchorage", island: "Meganisi" },
  otherBerths: ["Agios Georgios"],
  pageKind: "trip_report",
  observedAt: "2024-06-15",
  attributes: berthAttributes("v4"),
  text: "We anchored in Vathi.",
  limits: { quoteMinChars: 12, quoteMaxChars: 300 },
};

describe("extract-berth", () => {
  it("renders every variable of prompt v1; the berth-specific part stays in the user prompt", () => {
    const prompt = loadPrompt("extract-berth", 1);
    const vars = extractBerthTask.variables(input);
    const system = renderPrompt(prompt.system, vars);
    const user = renderPrompt(prompt.user, vars);
    expect(system).toContain("holding — Holding of the anchor");
    expect(system).toContain("at most 300 characters");
    expect(system).not.toContain("Meganisi");
    expect(user).toContain("Berth: Vathi (anchorage) – on Meganisi; also called Ormos Vathi");
    expect(user).toContain("Other berths on this page: Agios Georgios");
  });

  it("has an output schema structured outputs accept", () => {
    expect(() => structuredOutputSchema(z.toJSONSchema(extractBerthTask.output))).not.toThrow();
  });

  it("names a berth without island or other names plainly", () => {
    expect(berthLine({ name: "Kalo", names: ["Kalo"], kind: "mooring_field", island: null })).toBe("Kalo (mooring_field)");
  });
});
