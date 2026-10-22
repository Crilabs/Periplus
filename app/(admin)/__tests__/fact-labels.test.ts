import { describe, expect, it } from "vitest";
import { factSchemaV1 } from "@/config/fact-schema/v1";
import { EXPOSURE_SCALE, factSchemaV2, TEXT_SCALE } from "@/config/fact-schema/v2";
import { factSchemaV3 } from "@/config/fact-schema/v3";
import {
  EXPOSURE_SCALE_WORDS,
  FACT_ATTRIBUTE_LABELS,
  formatFactValue,
  MENTION_EXTRACTION_STATUS_LABELS,
  SHELTER_SCALE_WORDS,
} from "../_components/labels";

describe("fact labels", () => {
  it("every attribute of fact schema v1 to v3 has a German label", () => {
    const keys = new Set([factSchemaV1, factSchemaV2, factSchemaV3].flatMap((schema) => Object.values(schema.levels).flatMap((defs) => defs.map((d) => d.key))));
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
    expect(formatFactValue("season_notes", { months: [7, 8], kind: "crowded" })).toBe("Monate: Jul, Aug · Art: überfüllt");
    expect(formatFactValue("shelter.N", 0.73)).toBe("0,73");
  });

  it("words read right in their attribute's context", () => {
    expect(formatFactValue("occupancy", { "8": "full" })).toBe("Aug: voll");
    expect(formatFactValue("ferry_traffic", "none")).toBe("kein Fährverkehr");
    expect(formatFactValue("hazards", [{ kind: "rock", name: null }])).toBe("Art: Fels");
    expect(formatFactValue("shelter.N", 0.1)).toBe("kein Schutz (0,1)");
    expect(formatFactValue("swell_protection", 0.9)).toBe("gut geschützt (0,9)");
    expect(formatFactValue("meltemi_exposure", 0.5)).toBe("mäßig (0,5)");
  });

  it("the scale words cover exactly the values of the fact schema's text scales", () => {
    expect(Object.keys(SHELTER_SCALE_WORDS).sort()).toEqual(Object.values(TEXT_SCALE).map(String).sort());
    expect(Object.keys(EXPOSURE_SCALE_WORDS).sort()).toEqual(Object.values(EXPOSURE_SCALE).map(String).sort());
  });

  it("a mention whose unit failed has a German status", () => {
    expect(MENTION_EXTRACTION_STATUS_LABELS.failed).toBe("Fehlgeschlagen");
  });
});
