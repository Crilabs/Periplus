import { describe, expect, it } from "vitest";
import { factSchemaV1 } from "@/config/fact-schema/v1";
import { factSchemaV2 } from "@/config/fact-schema/v2";
import { FACT_ATTRIBUTE_LABELS, formatFactValue, MENTION_EXTRACTION_STATUS_LABELS } from "../_components/labels";

describe("fact labels", () => {
  it("every attribute of fact schema v1 and v2 has a German label", () => {
    const keys = new Set([factSchemaV1, factSchemaV2].flatMap((schema) => Object.values(schema.levels).flatMap((defs) => defs.map((d) => d.key))));
    const missing = [...keys].filter((k) => !FACT_ATTRIBUTE_LABELS[k]);
    expect(missing).toEqual([]);
    expect(FACT_ATTRIBUTE_LABELS["shelter.NE"]).toBe("Schutz aus NO");
    expect(FACT_ATTRIBUTE_LABELS["highlight.food"]).toBe("Highlight: Essen");
    expect(FACT_ATTRIBUTE_LABELS["services.fuel"]).toBe("Service: Treibstoff");
  });

  it("formats values in German with units and words", () => {
    expect(formatFactValue("depth.min", 6)).toBe("6 m");
    expect(formatFactValue("holding", "good")).toBe("gut");
    expect(formatFactValue("services.water", true)).toBe("ja");
    expect(formatFactValue("seabed", [{ type: "sand", share: 0.5 }, { type: "weed", share: 0.5 }])).toBe("Sand 50 %, Seegras/Algen 50 %");
    expect(formatFactValue("highlight.food", { present: true, names: ["Taverna Nikos"] })).toBe("vorhanden: ja · Namen: Taverna Nikos");
    expect(formatFactValue("occupancy", { "8": "full", "7": "moderate" })).toBe("Jul: mäßig, Aug: voll");
    expect(formatFactValue("season_notes", { months: [7, 8], kind: "crowded" })).toBe("Monate: Jul, Aug · Art: voll");
    expect(formatFactValue("shelter.N", 0.9)).toBe("0,9");
  });

  it("a mention whose unit failed has a German status", () => {
    expect(MENTION_EXTRACTION_STATUS_LABELS.failed).toBe("Fehlgeschlagen");
  });
});
