import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAreaFile, loadAreaFiles, parseAreaFile } from "../file";

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

  it("rejects a file <CC>.json whose country is another", () => {
    expect(() => parseAreaFile(gr(), "IT.json")).toThrow(/^Ungültige Revier-Datei IT\.json:.*country GR/);
  });
});

describe("loadAreaFiles", () => {
  const dirWith = (files: Record<string, unknown>) => {
    const dir = mkdtempSync(path.join(tmpdir(), "area-files-"));
    for (const [name, json] of Object.entries(files)) writeFileSync(path.join(dir, name), typeof json === "string" ? json : JSON.stringify(json));
    return dir;
  };

  it("rejects a file whose country is not its name", async () => {
    await expect(loadAreaFiles(dirWith({ "IT.json": gr() }))).rejects.toThrow(/IT\.json:.*country GR/);
  });

  it("rejects a file not named <CC>.json", async () => {
    await expect(loadAreaFiles(dirWith({ "greece.json": gr() }))).rejects.toThrow(/greece\.json/);
  });

  it("loadAreaFile reads only the country's file: a broken file of another country does not matter", async () => {
    const dir = dirWith({ "GR.json": gr(), "IT.json": "{ not json" });
    expect((await loadAreaFile("GR", dir))?.country).toBe("GR");
    expect(await loadAreaFile("HR", dir)).toBeNull();
    await expect(loadAreaFiles(dir)).rejects.toThrow(/IT\.json/);
  });
});
