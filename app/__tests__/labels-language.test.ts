import { describe, expect, it } from "vitest";
import { languageLabel } from "@/app/(admin)/_components/labels";

describe("languageLabel", () => {
  it("shows the undetermined code und as ohne Sprache and leaves real codes alone (B13)", () => {
    expect(languageLabel("und")).toBe("ohne Sprache");
    expect(languageLabel("el")).toBe("el");
    expect(languageLabel("de")).toBe("de");
  });
});
