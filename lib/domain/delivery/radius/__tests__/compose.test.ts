import { describe, expect, it } from "vitest";
import type { Region, Spot } from "@/contract";
import { manifestSchema, regionsFileSchema, spotsFileSchema, weatherPointsFileSchema } from "@/contract/v2";
import { getConfig } from "@/lib/config";
import type { DeliveryPackage } from "@/lib/domain/delivery/types";
import { REGION, SPOT_A, SPOT_M, SUBDIVISION_ID, TAVERNA, WEATHER_POINT, validPackage } from "@/test/fixtures/delivery/package-v4";
import { round5 } from "../../geo";
import { composeRadiusPackage } from "../compose";
import { destination } from "../geometry";
import type { ComposedRadius, RadiusInput, SourcePackage } from "../types";

const cfg = getConfig().delivery;
const KEY = "0123456789abcdef";
const R = 25;

/*
 * Two subdivision packages: the fixture (P1, the marina's subdivision, all objects within a few nm of the marina) and a
 * second subdivision (P2, ids `…ZE…`, younger), whose objects lie due north of the marina at chosen distances.
 */
const P2_SD = "sd_01J9ZE00000000000000000002";
const P2_IN = "sp_01J9ZE00000000000000000001";
const P2_OUT = "sp_01J9ZE00000000000000000002";
const RG_EDGE = "rg_01J9ZE00000000000000000001";
const RG_PARENT = "rg_01J9ZE00000000000000000002";
const RG_GRANDPARENT = "rg_01J9ZE00000000000000000003";
const RG_FAR = "rg_01J9ZE00000000000000000004";
const WP_MARGIN = "wp_01J9ZE00000000000000000001";
const WP_FAR = "wp_01J9ZE00000000000000000002";
const WP_FAR_REGION = "wp_01J9ZE00000000000000000003";

const P1 = validPackage();
const MARINA = P1.files["spots.json"].spots.find((s) => s.id === SPOT_M)!;
const CENTER = MARINA.position;

function northOf(nm: number) {
  const d = destination(CENTER, 0, nm);
  return { lat: round5(d.lat), lon: round5(d.lon) };
}

function source(pkg: DeliveryPackage, imageNames: string[] = []): SourcePackage {
  const coverage = pkg.manifest.coverage[0]!;
  if (coverage.status !== "delivered") throw new Error("fixture must be delivered");
  return {
    coverage: { ...coverage, status: "delivered" },
    generatedAt: pkg.manifest.generatedAt,
    spots: pkg.files["spots.json"].spots,
    regions: pkg.files["regions.json"].regions,
    weatherPoints: pkg.files["weather-points.json"].points,
    tiles: pkg.manifest.tiles,
    areas: pkg.manifest.areas,
    licenses: pkg.manifest.licenses,
    imageFiles: imageNames.map((name) => ({ name, sha256: "a".repeat(64), bytes: 100 })),
  };
}

function p1(): SourcePackage {
  const pkg = validPackage();
  pkg.manifest.licenses = [
    { name: "ODbL-1.0", attribution: "© OpenStreetMap contributors", url: "https://opendatacommons.org/licenses/odbl/1-0/", files: ["coast.geojson"], fields: ["spots.json#/spots/*/name"] },
  ];
  return source(pkg, [`images/${SPOT_A}-title.jpg`, `images/${TAVERNA}-title.jpg`]);
}

/** The second subdivision; `shared` adds the fixture's region to it in that form. */
function p2(shared?: (r: Region) => Region): SourcePackage {
  const base = validPackage();
  const [spotA] = base.files["spots.json"].spots;
  const [rg] = base.files["regions.json"].regions;
  const [wp] = base.files["weather-points.json"].points;
  const spot = (id: string, nm: number): Spot => ({ ...spotA!, id, position: northOf(nm), anchorPosition: undefined, regionId: RG_EDGE });
  const edgeSouth = northOf(R - 1).lat;
  const edgeNorth = northOf(R + 20).lat;
  const [w, e] = [CENTER.lon - 0.2, CENTER.lon + 0.2];
  const regions: Region[] = [
    {
      ...rg!,
      id: RG_EDGE,
      center: northOf(R + 10),
      radiusNm: 10,
      polygon: { type: "Polygon", coordinates: [[[w, edgeSouth], [e, edgeSouth], [e, edgeNorth], [w, edgeNorth], [w, edgeSouth]]] },
      parentId: RG_PARENT,
      spotIds: [P2_IN, P2_OUT],
    },
    { ...rg!, id: RG_PARENT, center: northOf(R + 60), radiusNm: 2, polygon: undefined, parentId: RG_GRANDPARENT, spotIds: [] },
    { ...rg!, id: RG_GRANDPARENT, center: northOf(R + 100), radiusNm: 2, polygon: undefined, parentId: null, spotIds: [] },
    { ...rg!, id: RG_FAR, center: northOf(R + 100), radiusNm: 2, polygon: undefined, parentId: null, spotIds: [] },
  ];
  for (const r of regions) delete (r as Partial<Region>).character;
  if (shared) regions.push(shared(structuredClone(rg!)));
  return {
    coverage: { id: P2_SD, key: "XT-ZWEI", name: "Zweiter Landesteil", status: "delivered", dataVersion: 5 },
    generatedAt: "2026-10-21T06:00:00.000Z",
    spots: [spot(P2_IN, R - 0.1), spot(P2_OUT, R + 0.1)],
    regions,
    weatherPoints: [
      { ...wp!, id: WP_MARGIN, position: northOf(R + 1), regionId: null },
      { ...wp!, id: WP_FAR, position: northOf(R + 3), regionId: null },
      { ...wp!, id: WP_FAR_REGION, position: northOf(R - 5), regionId: RG_FAR },
    ],
    tiles: [
      { id: "q025:804:502", lastRunAt: "2026-10-20T00:00:00.000Z", statesAsOf: "2026-10-20" },
      { id: "q025:900:600", lastRunAt: "2026-10-20T00:00:00.000Z", statesAsOf: "2026-10-20" },
    ],
    areas: [{ id: "ar_01J9ZE00000000000000000001", key: "zwei", names: [{ lang: "de", name: "Zweites Revier" }] }],
    licenses: [
      { name: "ODbL-1.0", attribution: "© OpenStreetMap contributors", url: "https://opendatacommons.org/licenses/odbl/1-0/", files: ["coast.geojson"], fields: ["regions.json#/regions/*/polygon"] },
    ],
    imageFiles: [
      { name: `images/${P2_IN}-title.jpg`, sha256: "b".repeat(64), bytes: 200 },
      { name: `images/${P2_OUT}-title.jpg`, sha256: "c".repeat(64), bytes: 300 },
      { name: `images/${TAVERNA}-title.jpg`, sha256: "d".repeat(64), bytes: 400 },
    ],
  };
}

function input(packages: SourcePackage[], patch: Partial<RadiusInput> = {}): RadiusInput {
  return { key: KEY, homeMarina: MARINA, days: 1, radiusNm: R, generatedAt: "2026-10-23T08:00:00.000Z", packages, missing: [], missingTiles: [], ...patch };
}

const ids = (list: Array<{ id: string }>) => list.map((o) => o.id);
const regionsOf = (c: ComposedRadius) => c.files["regions.json"].regions;
const without = <T extends object>(o: T) => ({ ...o, spotIds: undefined });

describe("composeRadiusPackage", () => {
  it("takes a spot at R − 0.1 nm and leaves one at R + 0.1 nm", () => {
    const out = composeRadiusPackage(input([p1(), p2()]), cfg);
    expect(ids(out.files["spots.json"].spots)).toEqual([SPOT_A, SPOT_M, P2_IN].sort());
  });

  it("has no highlights file in the composition", () => {
    const out = composeRadiusPackage(input([p1(), p2()]), cfg);
    expect(Object.keys(out.files).sort()).toEqual(["regions.json", "spots.json", "weather-points.json"]);
  });

  it("takes a region that only crosses the circle, with its parent chain, and trims its spotIds", () => {
    const out = composeRadiusPackage(input([p1(), p2()]), cfg);
    // RG_FAR only as the region of the weather point WP_FAR_REGION
    expect(ids(regionsOf(out))).toEqual([REGION, RG_EDGE, RG_PARENT, RG_GRANDPARENT, RG_FAR].sort());
    expect(regionsOf(out).find((r) => r.id === RG_EDGE)!.spotIds).toEqual([P2_IN]);
  });

  it("pulls in the region of an included spot even if it does not touch the circle", () => {
    const pkg = p2();
    pkg.weatherPoints.find((w) => w.id === WP_FAR_REGION)!.regionId = null;
    expect(ids(regionsOf(composeRadiusPackage(input([p1(), pkg]), cfg)))).not.toContain(RG_FAR);
    pkg.spots[0]!.regionId = RG_FAR;
    const out = composeRadiusPackage(input([p1(), pkg]), cfg);
    expect(ids(regionsOf(out))).toContain(RG_FAR);
  });

  it("takes every weather point within R + marginNm and pulls in its region with the parent chain", () => {
    const pkg = p2();
    pkg.regions.find((r) => r.id === RG_FAR)!.parentId = RG_GRANDPARENT;
    const out = composeRadiusPackage(input([p1(), pkg]), cfg);
    expect(ids(out.files["weather-points.json"].points)).toEqual([WEATHER_POINT, WP_MARGIN, WP_FAR_REGION].sort());
    expect(ids(regionsOf(out))).toEqual(expect.arrayContaining([RG_FAR, RG_GRANDPARENT]));
    expectValidFiles(out);
  });

  it("drops a weather point whose region is in no package, with a warning", () => {
    const pkg = p2();
    pkg.regions = pkg.regions.filter((r) => r.id !== RG_FAR);
    const out = composeRadiusPackage(input([p1(), pkg]), cfg);
    expect(ids(out.files["weather-points.json"].points)).not.toContain(WP_FAR_REGION);
    expect(out.warnings).toEqual([`${RG_FAR}: referenced but in no subdivision package`]);
  });

  it("a merged spot follows its target: inside with its target outside it is dropped, outside with its target inside it is kept", () => {
    const pkg = p2();
    const [inside, outside] = pkg.spots as [Spot, Spot];
    inside.mergedInto = P2_OUT;
    let out = composeRadiusPackage(input([p1(), pkg]), cfg);
    expect(ids(out.files["spots.json"].spots)).toEqual([SPOT_A, SPOT_M].sort());

    inside.mergedInto = null;
    outside.mergedInto = P2_IN;
    out = composeRadiusPackage(input([p1(), pkg]), cfg);
    expect(ids(out.files["spots.json"].spots)).toEqual([SPOT_A, SPOT_M, P2_IN, P2_OUT].sort());
    expect(regionsOf(out).find((r) => r.id === RG_EDGE)!.spotIds).toEqual([P2_IN, P2_OUT]);
  });

  it("a region in both packages: once, from the younger package, spotIds the union trimmed to included spots", () => {
    const pkg = p2((r) => ({ ...r, name: "Nisida (neu)", spotIds: [P2_IN, P2_OUT] }));
    const out = composeRadiusPackage(input([p1(), pkg]), cfg);
    const shared = regionsOf(out).filter((r) => r.id === REGION);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.name).toBe("Nisida (neu)");
    expect([...shared[0]!.spotIds].sort()).toEqual([SPOT_A, P2_IN].sort());
  });

  describe("a spot in both packages", () => {
    const a = P1.files["spots.json"].spots.find((s) => s.id === SPOT_A)!;
    const excluded = (name: string): Spot => ({ ...structuredClone(a), name, asOf: null, exclude: { excluded: true, reason: "anchoringProhibited", detail: null } });
    const confirmed = (name: string): Spot => ({ ...structuredClone(a), name });
    const pick = (older: Spot | null, younger: Spot) => {
      const old = p1();
      if (older) old.spots = old.spots.map((s) => (s.id === SPOT_A ? older : s));
      const young = p2();
      young.spots.push(younger);
      young.generatedAt = "2026-10-22T06:00:00.000Z";
      const out = composeRadiusPackage(input([old, young]), cfg);
      return { spot: out.files["spots.json"].spots.find((s) => s.id === SPOT_A)!, out };
    };

    it("older confirmed, younger excluded: excluded", () => {
      const { spot, out } = pick(confirmed("Alt"), excluded("Neu"));
      expect(spot.exclude?.excluded).toBe(true);
      expect(out.warnings.some((w) => w.startsWith(SPOT_A))).toBe(true);
    });

    it("older excluded, younger confirmed: excluded", () => {
      expect(pick(excluded("Alt"), confirmed("Neu")).spot.exclude?.excluded).toBe(true);
    });

    it("both confirmed: the younger package's copy, whatever the asOf", () => {
      expect(pick({ ...confirmed("Alt"), asOf: "2026-10-30" }, { ...confirmed("Neu"), asOf: "2026-09-01" }).spot.name).toBe("Neu");
    });

    it("identical copies give no warning", () => {
      expect(pick(confirmed("Gleich"), confirmed("Gleich")).out.warnings.some((w) => w.startsWith(SPOT_A))).toBe(false);
    });
  });

  it("a region in both packages with another name: younger package wins, one warning", () => {
    const pkg = p2((r) => ({ ...r, name: "Nisida Nord" }));
    const out = composeRadiusPackage(input([p1(), pkg]), cfg);
    expect(regionsOf(out).find((r) => r.id === REGION)!.name).toBe("Nisida Nord");
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain(REGION);
  });

  it("no warning for a shared object that differs only in spotIds", () => {
    const pkg = p2((r) => ({ ...r, character: { de: "Vor dem Meltemi geschützt." }, spotIds: [P2_IN] }));
    expect(composeRadiusPackage(input([p1(), pkg]), cfg).warnings).toEqual([]);
  });

  it("only the marina's subdivision touched: one delivered coverage entry, a valid package", () => {
    const out = composeRadiusPackage(input([p1()]), cfg);
    expect(out.manifestDraft.coverage).toEqual([
      { id: SUBDIVISION_ID, key: "XT-NISIDA", name: "Testlandesteil", status: "delivered", dataVersion: 2 },
    ]);
    expect(manifestSchema.omit({ files: true, objectCounts: true }).safeParse(out.manifestDraft).success).toBe(true);
    expectValidFiles(out);
  });

  it("missing subdivisions and tiles are listed: coverage sorted by key, tiles with lastRunAt null", () => {
    const missing = { id: "sd_01J9ZE00000000000000000003", key: "XT-AAA", name: "Lücke", status: "missing" as const, dataVersion: null };
    const out = composeRadiusPackage(input([p1(), p2()], { missing: [missing], missingTiles: ["q025:805:501"] }), cfg);
    expect(out.manifestDraft.coverage.map((c) => c.key)).toEqual(["XT-AAA", "XT-NISIDA", "XT-ZWEI"]);
    expect(out.manifestDraft.coverage[0]).toEqual(missing);
    expect(out.manifestDraft.tiles).toEqual([
      { id: "q025:804:501", lastRunAt: null, statesAsOf: null },
      { id: "q025:804:502", lastRunAt: "2026-10-20T00:00:00.000Z", statesAsOf: "2026-10-20" },
      { id: "q025:805:501", lastRunAt: null, statesAsOf: null },
    ]);
  });

  it("manifest draft: radius scope, bbox, areas and licences merged", () => {
    const out = composeRadiusPackage(input([p1(), p2()]), cfg);
    const scope = out.manifestDraft.scope;
    expect(scope).toMatchObject({ type: "radius", key: KEY, homeMarina: { id: SPOT_M, name: "Marina Nisida" }, center: CENTER, days: 1, radiusNm: R });
    expect(scope.type === "radius" && scope.circle.coordinates[0]).toHaveLength(65);
    expect(out.manifestDraft.schemaVersion).toBe("4.0");
    expect(out.manifestDraft.generatedAt).toBe("2026-10-23T08:00:00.000Z");
    expect(out.manifestDraft.bbox[3]).toBeGreaterThan(CENTER.lat);
    expect(out.manifestDraft.areas.map((a) => a.key)).toEqual(["nisida-test", "zwei"]);
    expect(out.manifestDraft.licenses).toEqual([
      {
        name: "ODbL-1.0",
        attribution: "© OpenStreetMap contributors",
        url: "https://opendatacommons.org/licenses/odbl/1-0/",
        files: ["coast.geojson"],
        fields: ["spots.json#/spots/*/name", "regions.json#/regions/*/polygon"],
      },
    ]);
    expect(manifestSchema.omit({ files: true, objectCounts: true }).safeParse(out.manifestDraft).success).toBe(true);
  });

  it("images of included spots only", () => {
    const out = composeRadiusPackage(input([p1(), p2()]), cfg);
    expect(out.imageFiles.map((f) => f.name).sort()).toEqual(
      [`images/${SPOT_A}-title.jpg`, `images/${P2_IN}-title.jpg`].sort(),
    );
  });

  it("no new value: every object, without spotIds, equals one of its input versions", () => {
    const p2Shared = p2((r) => ({ ...r, spotIds: [P2_IN] }));
    const packages = [p1(), p2Shared];
    const out = composeRadiusPackage(input(packages), cfg);
    const inputs = packages.flatMap((p) => [...p.spots, ...p.regions, ...p.weatherPoints]);
    const outputs = [
      ...out.files["spots.json"].spots,
      ...regionsOf(out),
      ...out.files["weather-points.json"].points,
    ];
    expect(outputs.length).toBeGreaterThan(0);
    for (const o of outputs) {
      const versions = inputs.filter((i) => i.id === o.id).map(without);
      expect(versions).toContainEqual(without(o));
    }
  });

  it("every file passes its schema, with a radius envelope and sorted lists", () => {
    const out = composeRadiusPackage(input([p1(), p2()]), cfg);
    expectValidFiles(out);
    expect(out.files["spots.json"].scope).toEqual({ type: "radius", key: KEY });
    expect(out.files["regions.json"].generatedAt).toBe("2026-10-23T08:00:00.000Z");
  });
});

function expectValidFiles(out: ComposedRadius) {
  const f = out.files;
  for (const [schema, file] of [
    [spotsFileSchema, f["spots.json"]],
    [regionsFileSchema, f["regions.json"]],
    [weatherPointsFileSchema, f["weather-points.json"]],
  ] as const) {
    const result = schema.safeParse(file);
    expect(result.error?.issues ?? []).toEqual([]);
  }
  for (const list of [f["spots.json"].spots, f["regions.json"].regions, f["weather-points.json"].points]) {
    expect(ids(list)).toEqual([...ids(list)].sort());
  }
}
