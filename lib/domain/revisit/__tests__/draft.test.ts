import { describe, expect, it } from "vitest";
import type { ProfileSnapshot } from "@/lib/domain/consolidation/types";
import { changeTypeOf, nameInText } from "../draft";

// Pure helpers of the scenario draft (ruling M7-H-R1, M-5): the place-name match of the ban entry and its change type.

describe("nameInText", () => {
  it("matches a name only as a whole word", () => {
    expect(nameInText("Anchoring is banned in Agia Marina bay.", ["Marina"])).toBe("Marina");
    expect(nameInText("Anchoring is banned near the Marinas.", ["Marina"])).toBeUndefined();
    expect(nameInText("Submarina wreck ahead.", ["Marina"])).toBeUndefined();
    expect(nameInText("Ankern vor Póros verboten.", ["Poros", "Póros"])).toBe("Póros");
    expect(nameInText("Απαγορεύεται η αγκυροβολία στον Πόρο.", ["Πόρο"])).toBe("Πόρο");
    expect(nameInText("Απαγορεύεται στον Πόρος.", ["Πόρο"])).toBeUndefined();
  });

  it("tries names in order, treats regex characters literally and skips blank names", () => {
    expect(nameInText("Ormos Vathy (south) and Vathy.", ["Ormos Vathy (south)", "Vathy"])).toBe("Ormos Vathy (south)");
    expect(nameInText("Bay a.b here", ["a+b", "a.b"])).toBe("a.b");
    expect(nameInText("anything", ["", "  "])).toBeUndefined();
  });
});

describe("changeTypeOf", () => {
  const profile = (attributes: Record<string, unknown>, provenance: string[]) =>
    ({ attributes, provenance: Object.fromEntries(provenance.map((k) => [k, {}])) }) as unknown as ProfileSnapshot;

  it("an explicitly empty list the profile carries is changed, a missing attribute is new", () => {
    expect(changeTypeOf(profile({ prohibitions: [] }, ["prohibitions"]), "prohibitions")).toBe("changed");
    expect(changeTypeOf(profile({ prohibitions: [{ kind: "anchoring" }] }, ["prohibitions"]), "prohibitions")).toBe("changed");
    expect(changeTypeOf(profile({}, []), "prohibitions")).toBe("new_attribute");
    expect(changeTypeOf(profile({ prohibitions: [] }, []), "prohibitions")).toBe("new_attribute");
    expect(changeTypeOf(undefined, "prohibitions")).toBe("new_attribute");
  });
});
