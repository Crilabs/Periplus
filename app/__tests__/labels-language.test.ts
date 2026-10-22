import { describe, expect, it } from "vitest";
import { languageLabel } from "@/app/(admin)/_components/labels";

describe("languageLabel", () => {
  it("shows the undetermined code und as unbekannt and leaves real codes alone", () => {
    expect(languageLabel("und")).toBe("unbekannt");
    expect(languageLabel("el")).toBe("el");
    expect(languageLabel("de")).toBe("de");
  });
});
