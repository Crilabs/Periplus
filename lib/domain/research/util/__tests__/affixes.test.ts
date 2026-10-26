import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { stripAffix } from "../affixes";

const affixes = getConfig().nameAffixes;

describe("stripAffix", () => {
  it("affixes are stripped with their hint", () => {
    expect(stripAffix("bucht von kolona", affixes)).toEqual({ core: "kolona", hint: "bay" });
    expect(stripAffix("vathy bay", affixes)).toEqual({ core: "vathy", hint: "bay" });
    expect(stripAffix("ορμο βαθυ", affixes)).toEqual({ core: "βαθυ", hint: "bay" });
    expect(stripAffix("bay", affixes)).toBeNull();
    expect(stripAffix("kolona", affixes)).toBeNull();
    // an affix only counts as a whole word
    expect(stripAffix("portokali beach", affixes)).toBeNull();
  });
});
