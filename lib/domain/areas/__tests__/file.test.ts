import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadAreaFiles, parseAreaFile } from "../file";

const gr = () => JSON.parse(readFileSync("config/area-imports/GR.json", "utf8")) as { areas: Array<Record<string, unknown>> };

describe("parseAreaFile", () => {
  it("parses config/area-imports/GR.json with 36 areas, crete has 5 names and 3 boundary points", async () => {
    const file = parseAreaFile(gr(), "GR.json");
    expect(file.country).toBe("GR");
    expect(file.areas).toHaveLength(36);
    const crete = file.areas.find((a) => a.key === "crete")!;
    expect(crete.names).toHaveLength(5);
    expect(crete.boundaryPoints).toHaveLength(3);
    const files = await loadAreaFiles();
    expect(files.map((f) => f.country)).toContain("GR");
  });

  it("rejects duplicate key", () => {
    const json = gr();
    json.areas.push(structuredClone(json.areas[0]!));
    expect(() => parseAreaFile(json, "GR.json")).toThrow(/^Ungültige Revier-Datei GR\.json:.*duplicate/);
  });

  it("rejects an area without evidence", () => {
    const json = gr();
    json.areas[0]!.evidence = [];
    expect(() => parseAreaFile(json, "GR.json")).toThrow(/^Ungültige Revier-Datei GR\.json:/);
  });

  it("rejects related to unknown key", () => {
    const json = gr();
    json.areas[0]!.related = [{ key: "nowhere", relation: "contains" }];
    expect(() => parseAreaFile(json, "GR.json")).toThrow(/^Ungültige Revier-Datei GR\.json:.*nowhere/);
  });
});
