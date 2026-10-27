import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FACT_SCHEMAS } from "@/config/fact-schema";
import { getFactSchema } from "@/lib/domain/facts/schema";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { countryConfig, getConfig, getConsolidationConfig, loadConfig } from "../index";
import { gazetteerSchema, modelsSchema, queuesSchema } from "../schemas";

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
  mentions?: unknown;
  nameAffixes?: unknown;
  extraction?: unknown;
  delivery?: unknown;
  images?: unknown;
  research?: unknown;
  subdivisions?: unknown;
  areas?: unknown;
  /** `consolidation/active.json`. */
  consolidationActive?: unknown;
  /** Rules version file name (without `.json`) to content; replaces the repo's `consolidation/v*.json`. */
  consolidation?: Record<string, unknown>;
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
    mentions: overrides.mentions ?? repoConfig.mentions,
    "name-affixes": overrides.nameAffixes ?? repoConfig.nameAffixes,
    extraction: overrides.extraction ?? repoConfig.extraction,
    delivery: overrides.delivery ?? repoConfig.delivery,
    images: overrides.images ?? repoConfig.images,
    research: overrides.research ?? repoConfig.research,
    subdivisions: overrides.subdivisions ?? repoConfig.subdivisions,
    areas: overrides.areas ?? repoConfig.areas,
  };
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
  }
  mkdirSync(join(dir, "fact-schema"));
  writeFileSync(join(dir, "fact-schema", "active.json"), JSON.stringify(overrides.factSchema ?? repoConfig.factSchema));
  mkdirSync(join(dir, "consolidation"));
  const { version: activeRules, ...activeRulesConfig } = repoConfig.consolidation;
  writeFileSync(
    join(dir, "consolidation", "active.json"),
    JSON.stringify(overrides.consolidationActive ?? { version: activeRules }),
  );
  for (const [name, value] of Object.entries(overrides.consolidation ?? { [activeRules]: activeRulesConfig })) {
    writeFileSync(join(dir, "consolidation", `${name}.json`), JSON.stringify(value));
  }
  return dir;
}

describe("subdivisions config", () => {
  const sub = () => structuredClone(repoConfig.subdivisions);
  const invalid = (value: unknown) => () => loadConfig(fixtureDir({ subdivisions: value }));

  it("loads subdivisions.json", () => {
    const c = getConfig().subdivisions;
    expect(c.countries.GR!.firstLevel).toBe(5);
    expect(c.countries.HR!.firstLevel).toBe(4);
    expect(c.countries.AL!.firstLevel).toBe(6);
    expect(c.countries.MC!.firstLevel).toBe("whole");
    expect(c.wholeCountry).toEqual(expect.arrayContaining(["LB", "IL", "CY"]));
    expect(c.split[0]!.parentKey).toBe("GR-L");
    expect(c.split[0]!.groups.map((g) => g.key)).toEqual(["GR-CYC", "GR-DOD"]);
    expect(c.extra.map((e) => [e.key, e.country, e.osmRelationId, e.cutFrom])).toEqual(
      expect.arrayContaining([
        ["CY-NC", "CY", 2514541, "CY"],
        ["GB-SBA", "GB", 3263728, "CY"],
      ]),
    );
    expect(c.keyOverrides["3263728"]).toBeUndefined();
    expect(c.countries.LY!.status).toBe("excluded");
    expect(c.mediterranean.marineRegionsMrgids).not.toContain(3369);
    expect(c.overrides["GR-J"]!.coastSections!.map((s) => s.key)).toEqual(["ermioni", "porto-cheli", "epidavros"]);
  });

  it("countryConfig returns a country and throws for an unknown one", () => {
    expect(countryConfig("GR").cycleDays).toBe(30);
    expect(() => countryConfig("XX")).toThrow("Unknown country XX");
  });

  it("rejects a split group without members", () => {
    const c = sub();
    c.split[0]!.groups[0]!.memberWikidataIds = [];
    expect(invalid(c)).toThrow(/^Invalid config .*subdivisions\.json: /);
  });

  it("rejects a merge key that is also a split group key", () => {
    const c = sub();
    c.merge = [{ key: "GR-CYC", memberKeys: ["GR-A", "GR-B"], names: { de: "x", en: "x", el: "x" } }];
    expect(invalid(c)).toThrow(/subdivisions\.json: .*GR-CYC/);
  });

  it("rejects coastSections with duplicate keys", () => {
    const c = sub();
    const sections = c.overrides["GR-J"]!.coastSections!;
    c.overrides["GR-J"]!.coastSections = [sections[0]!, sections[0]!];
    expect(invalid(c)).toThrow(/duplicate coast section key ermioni/);
  });
});

describe("loadConfig", () => {
  it("loads the repo config", () => {
    const c = loadConfig("config");
    expect(c.queues["system.ping"].retryLimit).toBe(2);
    // A fetched page may be a PDF transcribed page by page in one job: it must not expire after pg-boss's default 15 minutes.
    expect(c.queues["research.fetch"].expireInSeconds).toBeGreaterThanOrEqual(1800);
    // A package build holds its area lock and two pool connections; it must not expire and be retried meanwhile.
    expect(c.queues["delivery.build"].expireInSeconds).toBe(3600);
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

  it("Overpass queues expire no sooner than two parts' worst case (a 24-minute land job was fetched twice at the 15-minute default)", () => {
    const { retries, timeoutSeconds, retryDelaySeconds } = repoConfig.gazetteer.overpass;
    const worstCase = 2 * ((retries + 1) * (timeoutSeconds + 30) + retryDelaySeconds * (2 ** retries - 1));
    expect(worstCase).toBe(3900);
    for (const queue of ["gazetteer.build", "gazetteer.coarse"]) {
      expect(repoConfig.queues[queue]!.expireInSeconds, queue).toBeGreaterThanOrEqual(worstCase);
    }
    const queues = structuredClone(repoConfig.queues) as Record<string, Record<string, unknown>>;
    queues["gazetteer.build"] = { ...queues["gazetteer.build"], expireInSeconds: worstCase - 1 };
    expect(() => loadConfig(fixtureDir({ queues }))).toThrow(/queues\.json: gazetteer\.build\.expireInSeconds 3899 is below two Overpass parts' worst case, 3900 s/);
    // without a value pg-boss's default of 900 s applies and is refused
    const bare = structuredClone(repoConfig.queues) as Record<string, Record<string, unknown>>;
    delete bare["gazetteer.coarse"]!.expireInSeconds;
    expect(() => loadConfig(fixtureDir({ queues: bare }))).toThrow(/gazetteer\.coarse\.expireInSeconds 900 is below/);
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
    expect(loadConfig("config").factSchema).toEqual({ version: "v3" });
  });

  it("the config loader and the fact-schema access know the same fact schema versions", () => {
    expect(Object.keys(FACT_SCHEMAS).sort()).toEqual(["v1", "v2", "v3", "v4"]);
    for (const [version, schema] of Object.entries(FACT_SCHEMAS)) {
      expect(getFactSchema(version)).toBe(schema);
      expect(schema.version).toBe(version);
    }
    // the active one loads; a version outside the map is unknown to both
    expect(loadConfig(fixtureDir({ factSchema: { version: "v3" } })).factSchema).toEqual({ version: "v3" });
    expect(() => loadConfig(fixtureDir({ factSchema: { version: "v99" } }))).toThrow(/unknown fact schema version v99/);
    expect(() => getFactSchema("v99")).toThrow(/Unknown fact schema version v99/);
  });

  it("rejects a malformed fact schema version", () => {
    expect(() => loadConfig(fixtureDir({ factSchema: { version: "1" } }))).toThrow(/fact-schema\/active\.json/);
  });

  it("loads the geometry rules and the restrictions", () => {
    const c = loadConfig("config");
    expect(c.geometry.rulesVersion).toBe("geometry-2");
    expect(c.geometry.fetch).toEqual({ rayCount: 72, rayStepDeg: 5, maxRayM: 50000, confidence: 0.7 });
    expect(c.geometry.shelter).toEqual({ fMinM: 300, fMaxM: 20000, meanWeight: 0.7, minWeight: 0.3, confidence: 0.6 });
    expect(c.geometry.swell.noSourceValue).toBe(0.9);
    expect(c.geometry.depth.sampleDistancesM).toEqual([50, 100, 200]);
    expect(c.geometry.anchorArea).toMatchObject({ minDepthM: 3, maxDepthM: 12, landClearanceM: 30, nearshoreM: 120 });
    expect(c.geometry.restriction).toEqual({ minShare: 0.5, confidence: 0.9 });
    expect(c.restrictions).toEqual({ protectedAreaAnchoringBan: [] });
  });

  it("loads the navily sample parameters and rejects an out-of-range threshold", () => {
    expect(loadConfig("config").quality.navilySample).toEqual({ radiusM: 500, minPlaces: 20, minMatchedForSectorRates: 5 });
    // one source per threshold (ruling M7-P1): the spot check reads them from `navily`
    expect(loadConfig("config").quality.navily).toMatchObject({ protectedThreshold: 0.5, seabedShareMin: 0.3 });
    const bad = { ...repoConfig.quality, navily: { ...repoConfig.quality.navily, protectedThreshold: 1.5 } };
    expect(() => loadConfig(fixtureDir({ quality: bad }))).toThrow(/quality\.json.*protectedThreshold/);
    expect(loadConfig("config").quality.navily).toMatchObject({ excludedTypes: ["prohibited", "dry-berthing"], prohibitedTypes: ["prohibited"] });
    const orphan = { ...repoConfig.quality, navily: { ...repoConfig.quality.navily, prohibitedTypes: ["unknown-type"] } };
    expect(() => loadConfig(fixtureDir({ quality: orphan }))).toThrow(/quality\.json.*prohibitedTypes/);
    const duplicate = { ...repoConfig.quality, navilySample: { ...repoConfig.quality.navilySample, protectedThreshold: 0.5 } };
    expect(() => loadConfig(fixtureDir({ quality: duplicate }))).toThrow(/quality\.json/);
  });

  it("quality config loads the comparison set and the navily assistant", () => {
    const q = getConfig().quality;
    expect(q.comparisonSet).toEqual({ pilotSize: 50, perSubdivisionMin: 20, perSubdivisionMax: 30 });
    expect(q.navily.proposalVersion).toBe("navily-assistant/1");
    expect(q).not.toHaveProperty("targets");
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

  it("points the seabed layer at the workspace that serves it, paged by its primary key (B18)", () => {
    const { seabed } = loadConfig("config").datasets;
    const workspace = new URL(seabed.wfsUrl).pathname.split("/").at(-2);
    expect(workspace).toBe("emodnet_view");
    expect(seabed.typeName).toBe(`${workspace}:eusm2025_eunis2019_full`);
    expect(seabed.sortBy).toBeUndefined();
  });

  it("rejects a restriction layer with an unknown kind", () => {
    const datasets = structuredClone(repoConfig.datasets);
    (datasets.humanActivities.layers[0] as { kind: string }).kind = "wreck";
    expect(() => loadConfig(fixtureDir({ datasets }))).toThrow(/datasets\.json.*humanActivities\.layers\.0\.kind/);
  });

  it("rejects a missing config file", () => {
    expect(() => loadConfig(join(tmpdir(), "periplus-does-not-exist"))).toThrow();
  });

  it("loads categories and gazetteer settings", () => {
    const c = loadConfig("config");
    expect(c.categories.wikidata.Q40080).toBe("beach");
    expect(c.categories.osm).toContainEqual({ key: "shop", values: ["bakery"], category: "bakery", unnamed: false });
    expect(c.categories.osm).toContainEqual({ key: "highway", values: ["bus_stop"], category: "transport", unnamed: true });
    expect(c.categories.osm).toContainEqual({ key: "amenity", values: ["bus_station", "taxi", "ferry_terminal"], category: "transport", unnamed: true });
    expect(c.categories.osm).toContainEqual({ key: "man_made", values: ["pier", "jetty"], category: "landing", unnamed: true });
    expect(c.categories.osm).toContainEqual({ key: "leisure", values: ["slipway"], category: "landing", unnamed: true });
    expect(c.categories.osm).toContainEqual({ key: "natural", values: ["beach"], category: "beach", unnamed: true });
    expect(c.categories.osm).toContainEqual({ key: "historic", values: "*", category: "culture", unnamed: false });
    expect(c.gazetteer.overpass.timeoutSeconds).toBe(180);
    expect(c.gazetteer.wikidata.classes.Q23442).toBe("island");
    expect(c.gazetteer.geonames.featureCodes.PPLA2).toBe("settlement");
    expect(c.gazetteer.merge.distanceM.default).toBe(500);
    // Generic bay words are stripped token-wise from normalized names: each must normalize to one non-empty token.
    expect(c.gazetteer.merge.genericBayWords).toContain("ormos");
    for (const word of c.gazetteer.merge.genericBayWords) expect(normalizeName(word)).toMatch(/^\S+$/);
    expect(c.gazetteer.landBufferKm).toBe(55);
    expect(c.gazetteer).not.toHaveProperty("poiCoastDistanceKm");
    expect(c.gazetteer).not.toHaveProperty("coastSectionMaxAreaKm2");
    // The skeleton has no POI classes (N7, B8): the stage around the candidates brings its own.
    expect(Object.values(c.gazetteer.wikidata.classes)).not.toContain("poi");
    expect(c.gazetteer.noAnchoringKinds).toEqual(["military", "cable", "firing_area", "aquaculture"]);
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
    expect(fetch).not.toHaveProperty("chunk");
    expect(fetch.goneAfter).toBe(2);
    expect(fetch.renderMinMainChars).toBe(500);
  });

  it("converterBySource is keyed by lower-case source domain", () => {
    const byDomain = { ...repoConfig.fetch, converterBySource: { "sailing.example": "jina" } };
    expect(loadConfig(fixtureDir({ fetch: byDomain })).fetch.converterBySource).toEqual({ "sailing.example": "jina" });
    const byId = { ...repoConfig.fetch, converterBySource: { "0b9e4c1e-6f0a-4c39-9a52-4c0f4f1f2a10": "jina" } };
    expect(() => loadConfig(fixtureDir({ fetch: byId }))).toThrow(/fetch\.json.*converterBySource/);
  });

  it("loads discovery", () => {
    const c = loadConfig("config");
    expect(c.discovery.serp).toMatchObject({ depth: 20, reuseDays: 30, maxQueriesPerRun: 240 });
    expect(c.discovery.bay).toEqual({ minAnchorAreaM2: 20000, minWikidataNames: 2 });
    expect(c.discovery.proposals).toMatchObject({ defaultType: "trip_report" });
    expect(c.discovery.proposals.typeHints.map((h) => h.type)).toEqual([
      "forum",
      "authority",
      "marina",
      "pilot_guide",
      "pilot_guide",
      "trip_report",
    ]);
    expect(c.discovery.proposals.ignoreDomains).toContain("navily.com");
    expect(c).not.toHaveProperty("embeddings");
    expect(c).not.toHaveProperty("whitelist");
  });

  it("rejects a discovery template without {name} and an invalid type hint", () => {
    const discovery = structuredClone(repoConfig.discovery);
    discovery.placeWebsite.templates[0]!.template = "Törnbericht";
    expect(() => loadConfig(fixtureDir({ discovery }))).toThrow(/discovery\.json.*placeWebsite\.templates\.0\.template/);
    const d2 = structuredClone(repoConfig.discovery);
    d2.proposals.typeHints = [{ pattern: "(forum", type: "forum" }];
    expect(() => loadConfig(fixtureDir({ discovery: d2 }))).toThrow(/discovery\.json.*typeHints\.0\.pattern/);
  });
});

describe("text configuration", () => {
  const cfg = repoConfig;

  it("a batch poll job survives a provider outage of at least an hour before it dead-letters", () => {
    // pg-boss backoff: retry n (from 0) waits retryDelay * 2^n .. retryDelay * 2^(n+1) seconds.
    const poll = cfg.queues["ai.batch.poll"]!;
    expect(poll.retryBackoff).toBe(true);
    let minimumSeconds = 0;
    for (let n = 0; n < poll.retryLimit; n++) minimumSeconds += poll.retryDelaySeconds * 2 ** n;
    expect(minimumSeconds).toBeGreaterThanOrEqual(3600);
  });

  it("the haiku tasks leave room for thinking and the defaults fill in", () => {
    expect(cfg.models.tasks["assess-page"]).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", maxTokens: 4096 });
    expect(cfg.models.tasks["extract-berth"]).toMatchObject({ model: "claude-sonnet-5-5", promptVersion: 2, effort: "medium", maxTokens: 16000, cacheSystem: true });
    for (const gone of ["classify-document", "disambiguate-mention", "extract-facts", "summarize-profile"]) expect(cfg.models.tasks).not.toHaveProperty(gone);
    expect(cfg.models.tasks["extract-route"]).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", maxTokens: 16000 });
    expect(cfg.models.tasks["system.echo"]).toMatchObject({ effort: "low", cacheSystem: false });
    expect(cfg.models.batch).toEqual({ discount: 0.5, pollSeconds: 60, maxHours: 26, maxRequests: 1000, providerTimeoutSeconds: 120, leaseSeconds: 600, clockSkewSeconds: 120, reservationHours: 48, budgetRetrySeconds: 900 });
    expect(cfg.models).not.toHaveProperty("comparison");
  });

  it("a batch lease must outlast the provider call", () => {
    const models = JSON.parse(readFileSync("config/models.json", "utf8"));
    models.batch.leaseSeconds = models.batch.providerTimeoutSeconds;
    expect(() => modelsSchema.parse(models)).toThrow(/longer than providerTimeoutSeconds/);
  });

  it("every model named in tasks has a price", () => {
    for (const model of Object.values(cfg.models.tasks).map((t) => t.model)) expect(cfg.models.pricesEurPerMTok[model], model).toBeDefined();
    const m2 = structuredClone(cfg.models);
    m2.tasks["assess-page"]!.model = "claude-mystery-2";
    expect(() => loadConfig(fixtureDir({ models: m2 }))).toThrow(/models\.json.*claude-mystery-2/);
  });

  it("a task needs maxTokens and an effort from the list", () => {
    const models = structuredClone(cfg.models) as { tasks: Record<string, Record<string, unknown>> };
    delete models.tasks["assess-page"]!.maxTokens;
    expect(() => loadConfig(fixtureDir({ models }))).toThrow(/models\.json.*maxTokens/);
    const m2 = structuredClone(cfg.models) as { tasks: Record<string, Record<string, unknown>> };
    m2.tasks["assess-page"]!.effort = "max";
    expect(() => loadConfig(fixtureDir({ models: m2 }))).toThrow(/models\.json.*effort/);
  });

  it("affixes are stored normalized", () => {
    expect(cfg.nameAffixes.length).toBeGreaterThan(30);
    for (const { affix } of cfg.nameAffixes) expect(affix).toBe(normalizeName(affix));
    expect(cfg.nameAffixes).toContainEqual({ affix: "ορμοσ", position: "prefix", hint: "bay" });
    expect(cfg.nameAffixes).toContainEqual({ affix: "marina", position: "prefix", hint: "marina" });
    expect(cfg.nameAffixes).toContainEqual({ affix: "insel", position: "suffix", hint: "island" });
    const notNormalized = [...cfg.nameAffixes, { affix: "Όρμος", position: "prefix", hint: "bay" }];
    expect(() => loadConfig(fixtureDir({ nameAffixes: notNormalized }))).toThrow(/name-affixes\.json/);
  });

  it("an unknown affix hint is rejected", () => {
    const affixes = [...cfg.nameAffixes, { affix: "kirche", position: "suffix", hint: "church" }];
    expect(() => loadConfig(fixtureDir({ nameAffixes: affixes }))).toThrow(/name-affixes\.json.*hint/);
  });

  it("neighbourRing only allows 1 or 2", () => {
    expect(cfg.mentions.neighbourRing).toBe(1);
    expect(loadConfig(fixtureDir({ mentions: { ...cfg.mentions, neighbourRing: 2 } })).mentions.neighbourRing).toBe(2);
    expect(() => loadConfig(fixtureDir({ mentions: { ...cfg.mentions, neighbourRing: 3 } }))).toThrow(
      /mentions\.json.*neighbourRing/,
    );
  });

  it("loads the mention and extraction settings", () => {
    expect(cfg.mentions).toMatchObject({
      exactMinChars: 3,
      fuzzyMinChars: 5,
      sureSimilarity: 0.75,
      uncertainSimilarity: 0.6,
      maxCandidates: 6,
    });
    expect(cfg.mentions.stopNames).toContain("limani");
    expect(cfg.extraction.quote).toEqual({ minChars: 12, maxChars: 300 });
    expect(cfg.extraction.routeStop).toEqual({ nameMaxChars: 80, maxBeaufort: 12 });
    expect(cfg.extraction.geocode).toMatchObject({ radiusKm: 20, ratePerMinute: 60 });
    expect(cfg.extraction.earliestDate).toBe("1990-01-01");
  });

  it("rejects an uncertain similarity above the sure one and unknown extraction keys", () => {
    expect(() => loadConfig(fixtureDir({ mentions: { ...cfg.mentions, uncertainSimilarity: 0.8 } }))).toThrow(
      /mentions\.json/,
    );
    expect(() => loadConfig(fixtureDir({ extraction: { ...cfg.extraction, bogus: 1 } }))).toThrow(/extraction\.json/);
    const routeStop = (value: unknown) => loadConfig(fixtureDir({ extraction: { ...cfg.extraction, routeStop: value } }));
    expect(() => routeStop({ nameMaxChars: 80, maxBeaufort: 12, bogus: 1 })).toThrow(/extraction\.json/);
    expect(() => routeStop({ nameMaxChars: 80 })).toThrow(/extraction\.json/);
    expect(() => routeStop({ nameMaxChars: 0, maxBeaufort: 12 })).toThrow(/extraction\.json/);
  });
});

describe("consolidation rules", () => {
  /** The repo's active rules version as its file holds it (without the `version`, which is the file name). */
  const rulesFile = () => {
    const rules: Omit<typeof repoConfig.consolidation, "version"> & { version?: string } = structuredClone(
      repoConfig.consolidation,
    );
    delete rules.version;
    return rules;
  };

  it("consolidation v3 is active and keeps the rules of the berth state", () => {
    const c = getConfig().consolidation;
    expect(c.version).toBe("v3");
    expect(c).toMatchObject({
      recency: { halfLifeYears: 3 },
      precision: 3,
      conflict: { minRatio: 1.5 },
      confidence: { secondSourceBonus: 0.15, cap: 0.95, review: 0.95 },
      expiry: { cycles: 2, defaultCycleDays: 365 },
      weights: { computed: 1, review: 1, observed: 0.8, poi: 0.6 },
    });
    expect(c.rules.shelter).toMatchObject({ maxCorrection: 0.3, harbourFloor: 0.8, openSideMinConfidence: 0.7 });
    expect(c.rules.shelter.harbourKinds).toEqual(["port", "marina"]);
    expect(c.confidence.classes.map((k) => k.name)).toEqual(["high", "medium", "low"]);
    // identity keys of the list attributes merged by `union`; [] = the element itself
    expect(c.rules.union.keys).toEqual({
      hazards: ["kind", "name"],
      restricted_zones: ["kind", "name"],
      wind_systems: ["name"],
      season_notes: ["kind"],
      "mooring.types": [],
      charter_bases: [],
      supply_ports: [],
    });
    // the keys of the old profile pipeline are gone
    for (const gone of ["highlights", "importance", "quietness", "profileConfidence", "severity", "change", "followup", "summary"]) {
      expect(c, gone).not.toHaveProperty(gone);
    }
  });

  it("getConsolidationConfig reads the active version by default and a named one on demand", () => {
    expect(getConsolidationConfig()).toEqual(getConfig().consolidation);
    const active = repoConfig.consolidation.version;
    const later = { ...rulesFile(), conflict: { minRatio: 2 } };
    const dir = fixtureDir({ consolidation: { [active]: rulesFile(), v99: later } });
    expect(loadConfig(dir).consolidation.version).toBe(active);
    expect(getConsolidationConfig("v99", dir)).toMatchObject({ version: "v99", conflict: { minRatio: 2 } });
  });

  it("the rule parameters are validated", () => {
    const withRules = (patch: (c: ReturnType<typeof rulesFile>) => void) => {
      const c = rulesFile();
      patch(c);
      return () => loadConfig(fixtureDir({ consolidation: { v2: c }, consolidationActive: { version: "v2" } }));
    };
    expect(withRules((c) => ((c.confidence.classes[2] as { min: number }).min = 0.1))).toThrow(/consolidation\/v2\.json.*confidence/);
    expect(withRules((c) => Object.assign(c, { bogus: 1 }))).toThrow(/consolidation\/v2\.json/);
    expect(withRules(() => {})).not.toThrow();
  });

  it("union keys must be fields of the list entries in the fact schema", () => {
    const withKeys = (keys: Record<string, string[]>) => () => {
      const c = rulesFile();
      c.rules.union.keys = keys;
      return loadConfig(fixtureDir({ consolidation: { v2: c }, consolidationActive: { version: "v2" } }));
    };
    expect(withKeys({ hazards: ["kind", "nmae"] })).toThrow(/consolidation\/v2\.json.*"hazards".*"nmae"/);
    // A key on an entry that is no object (a list of enum values) cannot identify anything.
    expect(withKeys({ "mooring.types": ["kind"] })).toThrow(/"mooring\.types".*"kind"/);
    expect(withKeys({ no_such_attribute: [] })).toThrow(/no_such_attribute.*fact schema v3/);
    expect(withKeys({ hazards: ["kind", "name"] })).not.toThrow();
  });

  it("getConsolidationConfig caches per (version, dir)", () => {
    const dir = fixtureDir({ consolidation: { v3: rulesFile(), v2: { ...rulesFile(), conflict: { minRatio: 2 } } } });
    const other = fixtureDir({ consolidation: { v3: rulesFile(), v2: { ...rulesFile(), conflict: { minRatio: 3 } } } });
    const first = getConsolidationConfig("v2", dir);
    expect(getConsolidationConfig("v2", dir)).toBe(first);
    expect(getConsolidationConfig("v2", other)).not.toBe(first);
    expect(getConsolidationConfig("v2", other).conflict.minRatio).toBe(3);
    expect(first.conflict.minRatio).toBe(2);
  });

  it("an unknown rules version throws", () => {
    expect(() => getConsolidationConfig("v99")).toThrow(/v99/);
    expect(() => getConsolidationConfig("../models")).toThrow(/rules version/);
    expect(() => loadConfig(fixtureDir({ consolidationActive: { version: "v7" } }))).toThrow(/consolidation\/v7\.json/);
    expect(() => loadConfig(fixtureDir({ consolidationActive: { version: "1" } }))).toThrow(
      /consolidation\/active\.json/,
    );
  });
});

describe("delivery configuration", () => {
  it("the delivery config carries the spec values", () => {
    expect(getConfig().delivery).toMatchObject({
      schemaVersion: "4.0",
      coast: { marginNm: 2, simplifyToleranceM: 10 },
      validation: {
        maxWaterDistanceNm: 1.5,
        spotDuplicateM: 150,
        highlightDuplicateM: 500,
        maxDraftM: [0.5, 10],
        maxLengthM: [5, 100],
        lowConfidence: 0.3,
      },
    });
    expect(repoConfig.delivery).toMatchObject({
      spots: { statuses: ["confirmed", "no_anchoring"], maxSources: 20 },
      coast: { source: "OpenStreetMap, ODbL", restrictedSourceDefault: "EMODnet Human Activities" },
      regions: { types: ["island", "archipelago", "coast_section", "gulf", "channel"], pointRadiusNm: 2 },
      weather: { regionBufferNm: 3, capeOffsetNm: 1, capeLandRadiusM: 2000 },
      radius: { nmPerDay: 50, returnFactor: 0.5, minDays: 1, maxDays: 28 },
      validation: { harbourMinShelter: 0.8, lowConfidenceNote: "wenig belegt" },
      api: { cacheMaxAgeSeconds: 60 },
      build: { lockTimeoutMs: 300000 },
    });
    expect(repoConfig.delivery.forbiddenDomains).toContain("navily.com");
    expect(repoConfig.delivery.licenses).toEqual([
      expect.objectContaining({ name: "ODbL-1.0", attribution: "© OpenStreetMap contributors", files: ["coast.geojson"] }),
      // the three imagery sources of the title images (spec 13): licence entries for the image fields
      expect.objectContaining({ name: "CC-BY-3.0", files: [], fields: expect.arrayContaining(["spots.json#/spots/*/images"]) }),
      expect.objectContaining({ name: "CC-BY-4.0", files: [], fields: expect.arrayContaining(["spots.json#/spots/*/images"]) }),
      expect.objectContaining({ name: "Copernicus-DEM", files: [], fields: expect.arrayContaining(["spots.json#/spots/*/images"]) }),
    ]);
    expect(repoConfig.delivery.licenses[0]!.fields).toContain("regions.json#/regions/*/polygon");
  });

  it("rejects a missing or invalid delivery config", () => {
    const dir = fixtureDir({});
    rmSync(join(dir, "delivery.json"));
    expect(() => loadConfig(dir)).toThrow(/delivery\.json/);
    const withDelivery = (patch: (d: typeof repoConfig.delivery) => void) => {
      const delivery = structuredClone(repoConfig.delivery);
      patch(delivery);
      return () => loadConfig(fixtureDir({ delivery }));
    };
    expect(withDelivery(() => {})).not.toThrow();
    expect(withDelivery((d) => ((d as { schemaVersion: string }).schemaVersion = "1.0"))).toThrow(/delivery\.json.*schemaVersion/);
    expect(withDelivery((d) => (d.validation.maxDraftM = [10, 0.5]))).toThrow(/delivery\.json.*maxDraftM/);
    expect(withDelivery((d) => (d.spots.statuses = ["bogus" as never]))).toThrow(/delivery\.json.*statuses/);
    expect(withDelivery((d) => (d.regions.types = ["volcano" as never]))).toThrow(/delivery\.json.*types/);
    expect(withDelivery((d) => (d.forbiddenDomains = ["https://navily.com"]))).toThrow(/delivery\.json.*forbiddenDomains/);
    expect(withDelivery((d) => (d.licenses[0]!.files = ["land.json" as never]))).toThrow(/delivery\.json.*files/);
    expect(withDelivery((d) => (d.licenses[0]!.fields = ["land.json#/name"]))).toThrow(/delivery\.json.*fields/);
    expect(withDelivery((d) => (d.build.lockTimeoutMs = 0))).toThrow(/delivery\.json.*lockTimeoutMs/);
    // the contract caps a radius package's days at 28 (manifest scope `days`)
    expect(withDelivery((d) => (d.radius.maxDays = 29))).toThrow(/delivery\.json.*maxDays.*28/);
    expect(withDelivery((d) => (d.radius.maxDays = 14))).not.toThrow();
    expect(withDelivery((d) => Object.assign(d, { bogus: 1 }))).toThrow(/delivery\.json/);
  });
});

describe("retired area keys", () => {
  it("name the subdivision to pass instead of each former area", () => {
    expect(loadConfig("config").subdivisions.retiredAreaKeys).toEqual({ saronic: "GR-I", argolic: "GR-J" });
  });
});

describe("queue configuration", () => {
  it("rejects a misspelt key instead of dropping it, so a timeout never falls back to the pg-boss default (DAT-8)", () => {
    const entry = { concurrency: 8, retryLimit: 2, retryDelaySeconds: 120, retryBackoff: true };
    expect(queuesSchema.safeParse({ "fetch.url": { ...entry, expireInSeconds: 3600 } }).success).toBe(true);
    expect(queuesSchema.safeParse({ "fetch.url": { ...entry, expireInSecond: 3600 } }).success).toBe(false);
  });
});

describe("gazetteer overpass configuration", () => {
  it("rejects a minBlockDeg above blockDeg (B15)", () => {
    const gazetteer = loadConfig("config").gazetteer;
    const with_ = (blockDeg: number, minBlockDeg: number) =>
      gazetteerSchema.safeParse({ ...gazetteer, overpass: { ...gazetteer.overpass, blockDeg, minBlockDeg } });
    expect(with_(2, 0.5).success).toBe(true);
    expect(with_(2, 2).success).toBe(true);
    const result = with_(1, 2);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/minBlockDeg must not exceed blockDeg/);
  });
});

describe("areas config", () => {
  it("loads areas.json with aliases saronic → saronic-gulf", () => {
    const c = getConfig().areas;
    expect(c.aliases.saronic).toBe("saronic-gulf");
    expect(c.aliases.argolic).toBe("argolic-gulf");
    expect(c.minMembers).toBe(2);
    expect(c.memberTypes.island).toEqual(expect.arrayContaining(["island", "islet"]));
  });

  it("rejects a member type that is no geo object type", () => {
    const c = structuredClone(repoConfig.areas);
    (c.memberTypes as Record<string, string[]>).cape = ["nonsense"];
    expect(() => loadConfig(fixtureDir({ areas: c }))).toThrow(/areas/);
  });

  it("rejects a member type key that is no bot type, and a missing bot type", () => {
    const typo = structuredClone(repoConfig.areas) as { memberTypes: Record<string, string[]> };
    typo.memberTypes.harbor = typo.memberTypes.harbour!;
    delete typo.memberTypes.harbour;
    expect(() => loadConfig(fixtureDir({ areas: typo }))).toThrow(/areas/);
    const extra = structuredClone(repoConfig.areas) as { memberTypes: Record<string, string[]> };
    extra.memberTypes.lagoon = ["bay"];
    expect(() => loadConfig(fixtureDir({ areas: extra }))).toThrow(/areas/);
  });
});
