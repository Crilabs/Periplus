import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { areaByKey, loadConfig } from "../index";

const repoConfig = loadConfig("config");

type Overrides = {
  queues?: unknown;
  budgets?: unknown;
  models?: unknown;
  categories?: unknown;
  gazetteer?: unknown;
  factSchema?: unknown;
  geometry?: unknown;
  restrictions?: unknown;
  /** File name (without `.json`) to content; replaces all repo area files. */
  areas?: Record<string, unknown>;
};

/** Writes a temporary config dir: repo config files with the given overrides applied. */
function fixtureDir(overrides: Overrides): string {
  const dir = mkdtempSync(join(tmpdir(), "periplus-config-"));
  const files = {
    queues: overrides.queues ?? repoConfig.queues,
    budgets: overrides.budgets ?? repoConfig.budgets,
    models: overrides.models ?? repoConfig.models,
    categories: overrides.categories ?? repoConfig.categories,
    gazetteer: overrides.gazetteer ?? repoConfig.gazetteer,
    geometry: overrides.geometry ?? repoConfig.geometry,
    restrictions: overrides.restrictions ?? repoConfig.restrictions,
  };
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
  }
  mkdirSync(join(dir, "fact-schema"));
  writeFileSync(join(dir, "fact-schema", "active.json"), JSON.stringify(overrides.factSchema ?? repoConfig.factSchema));
  mkdirSync(join(dir, "areas"));
  const areas = overrides.areas ?? Object.fromEntries(repoConfig.areas.map((a) => [a.key, a]));
  for (const [name, value] of Object.entries(areas)) {
    writeFileSync(join(dir, "areas", `${name}.json`), JSON.stringify(value));
  }
  return dir;
}

const saronic = () => structuredClone(repoConfig.areas.find((a) => a.key === "saronic")!);

describe("loadConfig", () => {
  it("loads the repo config", () => {
    const c = loadConfig("config");
    expect(c.queues["system.ping"].retryLimit).toBe(2);
    expect(c.budgets.anthropic.dailyEur).toBeGreaterThan(0);
    expect(c.models.tasks["system.echo"].model).toBe("claude-haiku-5-5");
    expect(c.models.pricesEurPerMTok["claude-haiku-5-5"].input).toBeGreaterThan(0);
  });

  it("rejects a queue with concurrency 0", () => {
    expect(() =>
      loadConfig(
        fixtureDir({
          queues: {
            "system.ping": { concurrency: 0, retryLimit: 2, retryDelaySeconds: 60, retryBackoff: true },
          },
        }),
      ),
    ).toThrow(/concurrency/);
  });

  it("rejects an unknown budget service", () => {
    expect(() =>
      loadConfig(fixtureDir({ budgets: { ...repoConfig.budgets, bogus: { dailyEur: 1 } } })),
    ).toThrow(/bogus/);
  });

  it("names the file when a config file is malformed JSON", () => {
    const dir = fixtureDir({});
    writeFileSync(join(dir, "budgets.json"), "{ not json");
    expect(() => loadConfig(dir)).toThrow(/budgets\.json/);
  });

  it("loads the active fact schema version", () => {
    expect(loadConfig("config").factSchema).toEqual({ version: "v1" });
  });

  it("rejects a malformed fact schema version", () => {
    expect(() => loadConfig(fixtureDir({ factSchema: { version: "1" } }))).toThrow(/fact-schema\/active\.json/);
  });

  it("loads the geometry rules and the restrictions", () => {
    const c = loadConfig("config");
    expect(c.geometry.rulesVersion).toBe("geometry-1");
    expect(c.geometry.fetch).toEqual({ rayCount: 72, rayStepDeg: 5, maxRayM: 50000, confidence: 0.7 });
    expect(c.geometry.shelter).toEqual({ fMinM: 300, fMaxM: 20000, meanWeight: 0.7, minWeight: 0.3, confidence: 0.6 });
    expect(c.geometry.swell.noSourceValue).toBe(0.9);
    expect(c.geometry.depth.sampleDistancesM).toEqual([50, 100, 200]);
    expect(c.geometry.anchorArea).toMatchObject({ minDepthM: 3, maxDepthM: 12, landClearanceM: 30 });
    expect(c.geometry.restriction).toEqual({ minShare: 0.5, confidence: 0.9 });
    expect(c.restrictions).toEqual({ protectedAreaAnchoringBan: [] });
  });

  it("config rejects a malformed Natura 2000 code", () => {
    expect(() => loadConfig(fixtureDir({ restrictions: { protectedAreaAnchoringBan: ["GR300001"] } }))).toThrow(
      /restrictions\.json.*protectedAreaAnchoringBan/,
    );
    expect(loadConfig(fixtureDir({ restrictions: { protectedAreaAnchoringBan: ["GR3000001"] } })).restrictions)
      .toEqual({ protectedAreaAnchoringBan: ["GR3000001"] });
  });

  it("rejects unknown geometry keys and rays that do not cover the circle", () => {
    const geometry = structuredClone(repoConfig.geometry);
    expect(() => loadConfig(fixtureDir({ geometry: { ...geometry, bogus: 1 } }))).toThrow(/geometry\.json/);
    geometry.fetch.rayStepDeg = 4;
    expect(() => loadConfig(fixtureDir({ geometry }))).toThrow(/geometry\.json.*fetch/);
    geometry.fetch = { ...geometry.fetch, rayCount: 50, rayStepDeg: 7.2 };
    expect(() => loadConfig(fixtureDir({ geometry }))).toThrow(/geometry\.json.*sector centre/);
  });

  it("rejects shelter weights that do not sum to 1 and fMin not below fMax", () => {
    const geometry = structuredClone(repoConfig.geometry);
    geometry.shelter.minWeight = 0.4;
    expect(() => loadConfig(fixtureDir({ geometry }))).toThrow(/geometry\.json.*shelter/);
    const g2 = structuredClone(repoConfig.geometry);
    g2.shelter.fMinM = 20000;
    expect(() => loadConfig(fixtureDir({ geometry: g2 }))).toThrow(/geometry\.json.*shelter/);
  });

  it("rejects a missing config file", () => {
    expect(() => loadConfig(join(tmpdir(), "periplus-does-not-exist"))).toThrow();
  });

  it("loadConfig reads both areas", () => {
    const c = loadConfig("config");
    expect(c.areas.map((a) => a.key).sort()).toEqual(["argolic", "saronic"]);
    const s = c.areas.find((a) => a.key === "saronic")!;
    expect(s.names).toMatchObject({ de: "Saronischer Golf", en: "Saronic Gulf", el: "Σαρωνικός Κόλπος" });
    expect(s.tileBbox).toEqual([23.0, 37.0, 23.75, 38.0]);
    expect(s.coastSections.map((cs) => cs.key)).toEqual(["methana", "ermioni", "porto-cheli", "epidavros"]);
    expect(c.areas.find((a) => a.key === "argolic")!.tileBbox).toBeNull();
  });

  it("loads categories and gazetteer settings", () => {
    const c = loadConfig("config");
    expect(c.categories.wikidata.Q40080).toBe("beach");
    expect(c.categories.osm).toContainEqual({ key: "historic", values: "*", category: "culture" });
    expect(c.gazetteer.overpass.timeoutSeconds).toBe(180);
    expect(c.gazetteer.wikidata.classes.Q23442).toBe("island");
    expect(c.gazetteer.geonames.featureCodes.PPLA2).toBe("settlement");
    expect(c.gazetteer.merge.distanceM.default).toBe(500);
    expect(c.gazetteer.landBufferKm).toBe(55);
    expect(c.gazetteer.noAnchoringKinds).toEqual(["military", "cable", "firing_area", "aquaculture"]);
  });

  it("area without an el name is rejected", () => {
    const area = saronic();
    delete (area.names as Record<string, string>).el;
    expect(() => loadConfig(fixtureDir({ areas: { saronic: area } }))).toThrow(/saronic\.json.*names/);
  });

  it("area key must equal file name", () => {
    expect(() => loadConfig(fixtureDir({ areas: { "saronic-copy": saronic() } }))).toThrow(
      /saronic-copy\.json.*key/,
    );
  });

  it("rejects an unknown POI category", () => {
    const categories = structuredClone(repoConfig.categories);
    categories.wikidata.Q40080 = "bogus" as never;
    expect(() => loadConfig(fixtureDir({ categories }))).toThrow(/categories\.json/);
  });

  it("rejects an unknown geo object type in the gazetteer classes", () => {
    const gazetteer = structuredClone(repoConfig.gazetteer);
    gazetteer.wikidata.classes.Q23442 = "volcano" as never;
    expect(() => loadConfig(fixtureDir({ gazetteer }))).toThrow(/gazetteer\.json/);
  });
});

describe("areaByKey", () => {
  it("returns the area and throws on an unknown key", () => {
    expect(areaByKey("saronic").names.en).toBe("Saronic Gulf");
    expect(() => areaByKey("atlantis")).toThrow(/atlantis/);
  });
});
