import { describe, expect, it } from "vitest";
import { formatProfileValue, profileAttributeLabel } from "@/lib/domain/consolidation/format";

describe("formatProfileValue", () => {
  // depth: the fact formatter's "4 m" wins over the plan's "4,0 m" (ruling M5-P13)
  it.each([
    ["shelter.N", 0.62, "0,62"],
    ["shelter.SW", 0.9, "0,90"],
    ["swell_protection", 0.5, "0,50"],
    ["depth.min", 4, "4 m"],
    ["services.water", true, "ja"],
    ["services.fuel", false, "nein"],
    ["occupancy", { "7": "full", "8": "full", "1": "unknown" }, "Jul voll, Aug voll"],
    ["occupancy", { "1": "unknown" }, "unbekannt"],
    ["highlight.food", { present: true, names: ["Nikos", "Maria"] }, "ja: Nikos, Maria"],
    ["highlight.beach", { present: true, names: [] }, "ja"],
    ["highlight.food", { present: false, names: [] }, "nein"],
    ["exclude", { excluded: true, reason: "military", detail: null }, "ausgeschlossen (Militär)"],
    ["exclude", { excluded: false, reason: null, detail: null }, "nein"],
    ["seabed", [{ type: "sand", share: 0.5 }, { type: "weed", share: 0.5 }], "Sand 50 %, Seegras/Algen 50 %"],
    ["hazards", [{ kind: "rock", name: "Xera" }, { kind: "shoal", name: null }], "Fels (Xera), Untiefe"],
    ["season_notes", [{ kind: "crowded", months: [7, 8] }], "überfüllt (Jul, Aug)"],
    ["prohibitions", [{ kind: "anchoring", months: null }], "Ankern (ganzjährig)"],
    ["mooring.types", ["anchor", "lines_ashore"], "Anker, Landleinen"],
    ["holding", "good", "gut"],
    ["derived.quietness", 0.7222, "0,72"],
    ["derived.radius_nm", 20, "20 sm"],
  ])("formats %s %j", (a, v, s) => expect(formatProfileValue(a, v)).toBe(s));

  it("labels fact attributes and profile-only keys", () => {
    expect(profileAttributeLabel("holding")).toBe("Halt");
    expect(profileAttributeLabel("derived.quietness")).toBe("Ruhe-Index");
    expect(profileAttributeLabel("unknown.key")).toBe("unknown.key");
  });
});
