import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../../../lib/config";
import { distanceM } from "../../../lib/domain/gazetteer/rings";
import { loadNavilySpots, type NavilySpot } from "../../../lib/domain/quality/navily-sample";
import { isExcludedSpot } from "../../../lib/domain/research/gate-navily";
import { tileIdFor } from "../../../lib/domain/tiles";
import type { Assessment } from "./assess";
import type { Command } from "./cli";
import { clusterLocated, type WebPlace } from "./cluster";
import { CostLedger } from "./costs";
import type { ExtractRow } from "./extract";
import type { PageRow } from "./fetch";
import type { Located } from "./locate";
import { mcpSqlRows, mcpTool } from "./mcp";
import { renderReport } from "./report";
import type { Hit } from "./search-dataforseo";
import { readJson, readJsonl, writeJson } from "./store";

/*
 * Spec 5E: the only stage that reads the reference. Everything it writes into the repo is a count or a quota; the
 * per-spot lists stay in the pilot directory (Grundprinzip 9).
 */

export type Denominator = { name: string; tiles: Set<string>; spots: NavilySpot[]; clusters: Array<{ lon: number; lat: number; members: number[] }> };

/** Located mentions inside the area's tiles and those outside (pages of the search areas also describe GR-J and beyond). */
export function splitByArea(located: Located[], tiles: Set<string>): { inside: Located[]; outside: Located[] } {
  const inside: Located[] = [];
  const outside: Located[] = [];
  for (const l of located) {
    if (l.lon !== null && l.lat !== null && !tiles.has(tileIdFor(l.lon, l.lat))) outside.push(l);
    else inside.push(l);
  }
  return { inside, outside };
}

export type Metrics = {
  denominator: string;
  spots: number;
  clusters: number;
  covered1: Record<"150" | "300" | "600", number>;
  confirmedStrict300: number;
  confirmedAll300: number;
  clustersConfirmedStrict300: number;
  clustersConfirmedStrict300WithModel: number;
  byEngine: { dOnly: number; cOnly: number; both: number };
  byMethod: Record<string, number>;
  coordMentions: { count: number; medianDistanceM: number | null; within150: number };
  conflicts300: number;
  unresolved: Record<string, number>;
  unresolvedWithPosition: number;
  /** Located mentions outside this denominator's tiles (GR-J and beyond). */
  outside: number;
};

const BAY_RADIUS_M = 300;

function clusterPoints<T extends { lon: number; lat: number }>(points: T[], radiusM: number): Array<{ lon: number; lat: number; members: number[] }> {
  const clusters: Array<{ lon: number; lat: number; members: number[] }> = [];
  points.forEach((p, i) => {
    const c = clusters.find((k) => distanceM(k, p) <= radiusM);
    if (c) {
      c.members.push(i);
      c.lon = c.members.reduce((s, j) => s + points[j]!.lon, 0) / c.members.length;
      c.lat = c.members.reduce((s, j) => s + points[j]!.lat, 0) / c.members.length;
    } else clusters.push({ lon: p.lon, lat: p.lat, members: [i] });
  });
  return clusters;
}

/** "Kacheln GR-I" (all tiles, T2's denominator) and "Tor-Kacheln" (worked tiles, `tor.md`'s), excluded types removed. */
export function denominators(
  spots: NavilySpot[],
  gate: { tiles: { all: string[]; worked: string[] }; bufferM: number },
  navilyCfg: { excludedTypes: string[] },
): Denominator[] {
  // `tiles` is where web places may lie for this denominator (review fix 1: the gate's spots sit in neighbouring tiles
  // too, so its split must cover own ∪ worked tiles); `spots` are the reference spots counted.
  const make = (name: string, spotTiles: string[], splitTiles: string[]): Denominator => {
    const set = new Set(spotTiles);
    const inside = spots.filter((s) => set.has(tileIdFor(s.lon, s.lat)) && !isExcludedSpot(s, navilyCfg));
    return { name, tiles: new Set(splitTiles), spots: inside, clusters: clusterPoints(inside, BAY_RADIUS_M) };
  };
  return [make("Kacheln GR-I", gate.tiles.all, gate.tiles.all), make("Tor-Kacheln", gate.tiles.worked, [...gate.tiles.all, ...gate.tiles.worked])];
}

export type ClusterOpts = { copyMinSharedWords: number; engineOf: (url: string) => { d: boolean; c: boolean } };

/**
 * The metrics of one denominator: mentions split by its tiles, web places built twice — without model-located
 * mentions (binding figures) and with them (the "mit Modell" column, spec 5D.4; review fix 2).
 */
export function metricsFor(allLocated: Located[], den: Denominator, opts: ClusterOpts): Metrics {
  const { inside, outside } = splitByArea(allLocated, den.tiles);
  const noModel = inside.filter((l) => l.method !== "model");
  const places = clusterLocated(noModel, BAY_RADIUS_M, opts);
  const placesWithModel = clusterLocated(inside, BAY_RADIUS_M, opts);
  return { ...measure(places, inside, den, placesWithModel), outside: outside.length };
}

const nearest = (p: { lon: number; lat: number }, places: WebPlace[]): { place: WebPlace; d: number } | null => {
  let best: { place: WebPlace; d: number } | null = null;
  for (const place of places) {
    const d = distanceM(p, place);
    if (!best || d < best.d) best = { place, d };
  }
  return best;
};

export function measure(places: WebPlace[], located: Located[], den: Denominator, placesWithModel: WebPlace[] = places): Metrics {
  const covered1 = { "150": 0, "300": 0, "600": 0 };
  let confirmedStrict300 = 0;
  let confirmedAll300 = 0;
  const byEngine = { dOnly: 0, cOnly: 0, both: 0 };
  const byMethod: Record<string, number> = {};
  for (const s of den.spots) {
    const n = nearest(s, places);
    if (!n) continue;
    if (n.d <= 150) covered1["150"]++;
    if (n.d <= 300) covered1["300"]++;
    if (n.d <= 600) covered1["600"]++;
    const within300 = places.filter((p) => distanceM(s, p) <= 300);
    if (within300.some((p) => p.sourcesStrict >= 2)) confirmedStrict300++;
    if (within300.some((p) => p.sourcesAll >= 2)) confirmedAll300++;
    if (n.d <= 300) {
      const e = { d: within300.some((p) => p.engines.d), c: within300.some((p) => p.engines.c) };
      if (e.d && e.c) byEngine.both++;
      else if (e.d) byEngine.dOnly++;
      else if (e.c) byEngine.cOnly++;
      const method = Object.entries(n.place.methods).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
      byMethod[method] = (byMethod[method] ?? 0) + 1;
    }
  }
  const clusterConfirmed = (set: WebPlace[]) => den.clusters.filter((c) => set.some((p) => p.sourcesStrict >= 2 && c.members.some((i) => distanceM(den.spots[i]!, p) <= 300))).length;
  const coordRows = located.filter((l) => l.method === "coordinate" && l.lon !== null && l.lat !== null);
  const coordDistances = coordRows.map((l) => Math.min(...den.spots.map((s) => distanceM(s, { lon: l.lon!, lat: l.lat! })))).filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  const median = coordDistances.length === 0 ? null : coordDistances[Math.floor(coordDistances.length / 2)]!;
  const conflicts300 = places.filter((p) => p.sourcesStrict >= 2 && !den.spots.some((s) => distanceM(s, p) <= 300)).length;
  const unresolved: Record<string, number> = {};
  let unresolvedWithPosition = 0;
  for (const l of located) {
    if (l.method !== null) continue;
    const r = (l.reason ?? "?").split("+")[0]!;
    unresolved[r] = (unresolved[r] ?? 0) + 1;
    if (l.positionQuote) unresolvedWithPosition++;
  }
  return {
    denominator: den.name,
    spots: den.spots.length,
    clusters: den.clusters.length,
    covered1,
    confirmedStrict300,
    confirmedAll300,
    clustersConfirmedStrict300: clusterConfirmed(places),
    clustersConfirmedStrict300WithModel: clusterConfirmed(placesWithModel),
    outside: 0,
    byEngine,
    byMethod,
    coordMentions: { count: coordRows.length, medianDistanceM: median, within150: coordDistances.filter((d) => d <= 150).length },
    conflicts300,
    unresolved,
    unresolvedWithPosition,
  };
}

type GateInputLite = { tiles: { all: string[]; worked: string[] }; bufferM: number };

export const compareCommand: Command = async (_args, dir) => {
  const cfg = getConfig();
  const navilyPath = process.env.NAVILY_SPOTS_PATH;
  if (!navilyPath) throw new Error("NAVILY_SPOTS_PATH is not set");
  const spots = await loadNavilySpots(navilyPath);
  const answer = (await mcpTool("gate_input", { subdivision: "GR-I" })) as { version?: { gitSha: string | null }; input?: GateInputLite };
  const gate = answer?.input;
  if (!gate?.tiles?.worked) throw new Error("gate_input: no tiles in answer");
  // `gate_input.tiles.all` is the 56-tile frame with neighbours; the subdivision's own 34 tiles (T2's denominator) come from `tiles`.
  const own = (await mcpSqlRows<{ id: string }>(`select t.id from tiles t join subdivisions s on s.id = t.subdivision_id where s.key = 'GR-I' and t.valid_to is null order by t.id`)).map((r) => r.id);
  const allLocated = (await readJson<Located[]>(dir, "located.json")) ?? [];
  const hits = await readJsonl<Hit>(dir, "hits.jsonl");
  const enginesOf = new Map<string, { d: boolean; c: boolean }>();
  for (const h of hits) {
    const e = enginesOf.get(h.url) ?? { d: false, c: false };
    e[h.engine] = true;
    enginesOf.set(h.url, e);
  }
  const dens = denominators(spots, { tiles: { all: own, worked: gate.tiles.worked }, bufferM: gate.bufferM }, cfg.quality.navily);
  const opts: ClusterOpts = { copyMinSharedWords: cfg.research.confirmation.copyMinSharedWords, engineOf: (url) => enginesOf.get(url) ?? { d: false, c: false } };
  const metrics = dens.map((d) => metricsFor(allLocated, d, opts));
  // the lists and the domain table follow the binding denominator
  const { inside: located, outside } = splitByArea(allLocated, dens[0]!.tiles);
  const places = clusterLocated(located.filter((l) => l.method !== "model"), BAY_RADIUS_M, opts);

  const pages = await readJsonl<PageRow>(dir, "pages.jsonl");
  const assessments = await readJsonl<Assessment>(dir, "assessments.jsonl");
  const extracts = await readJsonl<ExtractRow>(dir, "extract.jsonl");
  const counting = new Set<string>(cfg.research.confirmation.countingPageKinds);
  // "tragende Seite" (spec 6): a counting page with at least one mention located inside GR-I; per search engine
  const bearingUrls = new Set(located.filter((l) => l.method !== null).map((l) => l.url));
  const bearing = { d: 0, c: 0, both: 0 };
  for (const url of bearingUrls) {
    const e = enginesOf.get(url) ?? { d: false, c: false };
    if (e.d && e.c) bearing.both++;
    else if (e.d) bearing.d++;
    else if (e.c) bearing.c++;
  }
  const domainStats = new Map<string, { pages: number; mentions: number }>();
  for (const l of located) {
    const s = domainStats.get(l.domain) ?? { pages: 0, mentions: 0 };
    s.mentions++;
    domainStats.set(l.domain, s);
  }
  for (const p of new Set(located.map((l) => l.url))) {
    const d = located.find((l) => l.url === p)!.domain;
    domainStats.get(d)!.pages++;
  }
  const topDomains = [...domainStats.entries()]
    .map(([domain, s]) => ({ domain, ...s }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 25);
  const ledger = await CostLedger.open(dir);
  const report = renderReport({
    metrics,
    outside: outside.length,
    costs: { totalEur: ledger.totalEur, byStage: ledger.byStage(), capEur: ledger.capEur },
    bearing,
    counts: {
      queriesD: (await readJsonl(dir, "queries-d.jsonl")).length,
      queriesC: (await readJsonl(dir, "queries-c.jsonl")).length,
      hitsD: new Set(hits.filter((h) => h.engine === "d").map((h) => h.url)).size,
      hitsC: new Set(hits.filter((h) => h.engine === "c").map((h) => h.url)).size,
      hitsBoth: [...enginesOf.values()].filter((e) => e.d && e.c).length,
      pages: pages.filter((p) => !p.error).length,
      assessed: assessments.filter((a) => !a.error).length,
      counting: assessments.filter((a) => !a.error && counting.has(a.page_kind) && !a.generated).length,
      mentions: allLocated.length,
      dropped: extracts.reduce((s, e) => s + e.dropped.length, 0),
    },
    topDomains,
    generatedAt: new Date(),
  });
  await writeJson(dir, "metrics.json", metrics);
  await mkdir(path.join(dir, "lists"), { recursive: true });
  // per-spot lists stay here, outside the repo
  const lines = dens[0]!.spots.map((s, i) => {
    const n = nearest(s, places);
    return [i, s.name ?? "", s.type ?? "", n ? n.d.toFixed(0) : "", n ? n.place.id : "", n ? n.place.sourcesStrict : "", n ? n.place.mentions.map((m) => m.name).join("; ") : ""].join("\t");
  });
  await writeFile(path.join(dir, "lists", "spots.tsv"), `index\tname\ttype\tnearest_m\tplace\tsources_strict\tmention_names\n${lines.join("\n")}\n`, "utf8");
  const conflictLines = places.filter((p) => p.sourcesStrict >= 2 && !dens[0]!.spots.some((s) => distanceM(s, p) <= 300)).map((p) => [p.id, p.lat.toFixed(5), p.lon.toFixed(5), p.sourcesStrict, p.mentions.map((m) => `${m.name} <${m.url}>`).join("; ")].join("\t"));
  await writeFile(path.join(dir, "lists", "conflicts.tsv"), `place\tlat\tlon\tsources_strict\tmentions\n${conflictLines.join("\n")}\n`, "utf8");
  // the generated report stays in the pilot directory; the committed protocol is written by hand from it
  const reportPath = path.join(dir, "report.md");
  await writeFile(reportPath, report, "utf8");
  process.stdout.write(`${report}\n→ ${reportPath}\n`);
};
