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
  };
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
  }
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
    expect(c.gazetteer.noAnchoringKinds).toEqual(["military", "cable", "firing_area"]);
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
