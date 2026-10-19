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
  datasets?: unknown;
  quality?: unknown;
  sourceTypes?: unknown;
  discovery?: unknown;
  fetch?: unknown;
  embeddings?: unknown;
  whitelist?: unknown;
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
    datasets: overrides.datasets ?? repoConfig.datasets,
    quality: overrides.quality ?? repoConfig.quality,
    "source-types": overrides.sourceTypes ?? repoConfig.sourceTypes,
    discovery: overrides.discovery ?? repoConfig.discovery,
    fetch: overrides.fetch ?? repoConfig.fetch,
    embeddings: overrides.embeddings ?? repoConfig.embeddings,
    "sources-whitelist": overrides.whitelist ?? repoConfig.whitelist,
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
    // A crawled PDF is transcribed page by page in one job: it must not expire after pg-boss's default 15 minutes.
    expect(c.queues["fetch.url"].expireInSeconds).toBeGreaterThanOrEqual(3600);
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

  it("rejects a queue expiry below one second", () => {
    expect(() =>
      loadConfig(
        fixtureDir({
          queues: {
            "system.ping": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 60, retryBackoff: true, expireInSeconds: 0 },
          },
        }),
      ),
    ).toThrow(/expireInSeconds/);
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
    expect(loadConfig("config").factSchema).toEqual({ version: "v2" });
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

  it("loads the navily sample parameters and rejects an out-of-range threshold", () => {
    expect(loadConfig("config").quality.navilySample).toEqual({
      radiusM: 500,
      protectedThreshold: 0.5,
      seabedMinShare: 0.3,
      minPlaces: 20,
      minMatchedForSectorRates: 5,
    });
    const bad = { navilySample: { ...repoConfig.quality.navilySample, protectedThreshold: 1.5 } };
    expect(() => loadConfig(fixtureDir({ quality: bad }))).toThrow(/quality\.json.*protectedThreshold/);
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

  it("loads the dataset endpoints", () => {
    const c = loadConfig("config");
    expect(c.datasets.bathymetry).toMatchObject({ coverageId: "emodnet__mean", datasetVersion: "2024", valueIsElevation: true });
    expect(c.datasets.seabed.substrateField).toBe("substrate");
    expect(c.datasets.humanActivities.layers.map((l) => l.kind)).toContain("protected_area");
    expect(c.datasets.vesselDensity.coverageId).toBe("emodnet__vesseldensity_allavg");
    expect(c.datasets.cables).toEqual({ kind: "cable", bufferM: 200 });
    expect(c.datasets.roads.highways).toContain("residential");
    expect(c.datasets.bufferKm).toBe(2);
  });

  it("rejects a restriction layer with an unknown kind", () => {
    const datasets = structuredClone(repoConfig.datasets);
    (datasets.humanActivities.layers[0] as { kind: string }).kind = "wreck";
    expect(() => loadConfig(fixtureDir({ datasets }))).toThrow(/datasets\.json.*humanActivities\.layers\.0\.kind/);
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

describe("source configuration", () => {
  it("the source type weights match spec 05", () => {
    const { sourceTypes } = loadConfig("config");
    expect(Object.fromEntries(Object.entries(sourceTypes).map(([t, v]) => [t, v.weight]))).toEqual({
      pilot_guide: 0.9,
      authority: 0.9,
      marina: 0.8,
      trip_report: 0.6,
      travel_guide: 0.5,
      forum: 0.4,
      dataset: 0.9,
      other: 0.3,
    });
    expect(sourceTypes.marina.changeRate).toBe("high");
    expect(sourceTypes.forum.changeRate).toBe("high");
    expect(sourceTypes.pilot_guide.changeRate).toBe("static");
    expect(sourceTypes.dataset.changeRate).toBe("static");
    expect(sourceTypes.trip_report.changeRate).toBe("normal");
  });

  it("rejects a source types file missing a type or with a weight above 1", () => {
    const sourceTypes = structuredClone(repoConfig.sourceTypes) as Record<string, unknown>;
    delete sourceTypes.other;
    expect(() => loadConfig(fixtureDir({ sourceTypes }))).toThrow(/source-types\.json.*other/);
    const heavy = structuredClone(repoConfig.sourceTypes);
    heavy.forum.weight = 1.2;
    expect(() => loadConfig(fixtureDir({ sourceTypes: heavy }))).toThrow(/source-types\.json.*forum\.weight/);
  });

  it("config/fetch.json starts with a provisional local converter", () => {
    const { fetch } = loadConfig("config");
    expect(fetch.defaultConverter).toBe("local");
    expect(fetch.converterBySource).toEqual({});
    expect(fetch.decision.status).toBe("provisional");
    expect(fetch.trackingParams).toEqual(["utm_*", "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid"]);
    expect(fetch.chunk).toEqual({ targetWords: 500, maxWords: 800, maxOverlapWords: 200 });
    expect(fetch.goneAfter).toBe(2);
    expect(fetch.renderMinMainChars).toBe(500);
  });

  it("converterBySource is keyed by lower-case source domain", () => {
    const byDomain = { ...repoConfig.fetch, converterBySource: { "sailing.example": "jina" } };
    expect(loadConfig(fixtureDir({ fetch: byDomain })).fetch.converterBySource).toEqual({ "sailing.example": "jina" });
    const byId = { ...repoConfig.fetch, converterBySource: { "0b9e4c1e-6f0a-4c39-9a52-4c0f4f1f2a10": "jina" } };
    expect(() => loadConfig(fixtureDir({ fetch: byId }))).toThrow(/fetch\.json.*converterBySource/);
  });

  it("loads discovery, embeddings and the whitelist", () => {
    const c = loadConfig("config");
    expect(c.discovery.serp).toMatchObject({ depth: 20, reuseDays: 30, maxQueriesPerRun: 240 });
    expect(c.discovery.templates.tile).toContainEqual({ template: "αγκυροβόλιο {name}", lang: "el", locationCode: 2300 });
    expect(c.discovery.bay).toEqual({ minAnchorAreaM2: 20000, minWikidataNames: 2 });
    expect(c.discovery.proposals).toMatchObject({ minSerpHits: 3, minLinkingSources: 2, defaultType: "trip_report" });
    expect(c.discovery.proposals.typeHints.map((h) => h.type)).toEqual([
      "forum",
      "authority",
      "marina",
      "pilot_guide",
      "pilot_guide",
      "trip_report",
    ]);
    expect(c.discovery.proposals.ignoreDomains).toContain("navily.com");
    expect(c.embeddings).toMatchObject({ provider: "voyage", model: "voyage-3.5", dimension: 1024 });
    expect(c.whitelist).toHaveLength(1);
    expect(c.whitelist[0]).toMatchObject({ domain: "wikivoyage.org", type: "travel_guide", changeRate: "normal" });
    expect(c.whitelist[0]!.crawlRules).toMatchObject({ allow: ["^/wiki/[^:?]+$"], maxDepth: 0, render: "never", pdf: false });
  });

  it("rejects a discovery template without {name} and an invalid type hint", () => {
    const discovery = structuredClone(repoConfig.discovery);
    discovery.templates.area[0]!.template = "Törnbericht";
    expect(() => loadConfig(fixtureDir({ discovery }))).toThrow(/discovery\.json.*templates\.area\.0\.template/);
    const d2 = structuredClone(repoConfig.discovery);
    d2.proposals.typeHints = [{ pattern: "(forum", type: "forum" }];
    expect(() => loadConfig(fixtureDir({ discovery: d2 }))).toThrow(/discovery\.json.*typeHints\.0\.pattern/);
  });

  it("rejects whitelist crawl rules with defaults filled in or invalid", () => {
    const whitelist = structuredClone(repoConfig.whitelist);
    whitelist[0]!.crawlRules = { maxDepth: 42 };
    expect(() => loadConfig(fixtureDir({ whitelist }))).toThrow(/sources-whitelist\.json.*crawlRules\.maxDepth/);
    expect(repoConfig.whitelist[0]!.crawlRules).not.toHaveProperty("maxPages");
  });

  it("rejects an embeddings dimension that is not a positive integer", () => {
    expect(() => loadConfig(fixtureDir({ embeddings: { ...repoConfig.embeddings, dimension: 0 } }))).toThrow(
      /embeddings\.json.*dimension/,
    );
  });
});

describe("areaByKey", () => {
  it("returns the area and throws on an unknown key", () => {
    expect(areaByKey("saronic").names.en).toBe("Saronic Gulf");
    expect(() => areaByKey("atlantis")).toThrow(/atlantis/);
  });
});
