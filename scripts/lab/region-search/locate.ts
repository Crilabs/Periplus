import { getConfig, type NameAffixesConfig } from "../../../lib/config";
import { normalizeName } from "../../../lib/domain/gazetteer/names";
import { distanceM } from "../../../lib/domain/gazetteer/rings";
import { berthNameMatches } from "../../../lib/domain/research/assign";
import type { Area } from "./areas";
import { parseFlags, type Command } from "./cli";
import { CostLedger } from "./costs";
import type { Mention } from "./extract";
import { readGazetteer, type GazObject } from "./gazetteer";
import { appendJsonl, readJson, readJsonl, writeJson } from "./store";

/*
 * Spec 5D: a mention becomes a point by, in this order, its literal coordinate, a gazetteer object with a matching
 * name (and island, when both say one), or (Task 7b, `locate --model`) the model's choice among the area's objects.
 */

export type LocateMethod = "coordinate" | "gazetteer" | "model";

export type Located = Mention & { method: LocateMethod | null; lon: number | null; lat: number | null; reason: string | null; gazId: string | null };

/**
 * Which object type fits the mention's kind best (ruling, Task 7): a port is the harbour, not the town or the cape of
 * the same name; an anchorage is the bay, else the beach. Ambiguity is judged among the best-ranked objects only.
 */
const TYPE_RANK: Record<Mention["kind"], string[]> = {
  anchorage: ["bay", "poi", "harbour", "cape", "settlement", "island", "islet"],
  mooring_field: ["bay", "harbour", "poi", "settlement", "cape", "island", "islet"],
  port: ["harbour", "settlement", "bay", "poi", "cape", "island", "islet"],
  marina: ["harbour", "settlement", "bay", "poi", "cape", "island", "islet"],
  unknown: ["bay", "harbour", "poi", "settlement", "cape", "island", "islet"],
};
const SAME_PLACE_M = 300;

const contains = (a: string, b: string): boolean => {
  const x = normalizeName(a);
  const y = normalizeName(b);
  return x !== "" && y !== "" && (` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `));
};

/**
 * The island the page's area names, if it names one; a gulf or coast as area must not reject objects on its islands
 * (ruling, Task 10: "Poros" placed in the "Saronic Gulf" was rejected against the island filter).
 */
export function islandOf(area: string | null, gaz: GazObject[]): string | null {
  if (!area) return null;
  const island = gaz.find((g) => (g.type === "island" || g.type === "islet") && g.names.some((n) => contains(n, area)));
  return island ? (island.islandName ?? island.names[0]!) : null;
}

export function locateByGazetteer(m: Mention, gaz: GazObject[], affixes: NameAffixesConfig): { object: GazObject } | { reason: "no_match" | "ambiguous" } {
  const names = [m.name, ...m.aliases];
  const island = islandOf(m.area, gaz);
  const hits = gaz.filter((g) => names.some((n) => berthNameMatches({ name: n, island }, g.names, affixes, g.islandName ? [g.islandName] : [])));
  if (hits.length === 0) return { reason: "no_match" };
  const rank = (g: GazObject) => {
    const i = TYPE_RANK[m.kind].indexOf(g.type);
    return i < 0 ? 9 : i;
  };
  const sorted = [...hits].sort((a, b) => rank(a) - rank(b));
  const best = sorted[0]!;
  const peers = sorted.filter((g) => rank(g) === rank(best));
  if (peers.some((g) => distanceM(g, best) > SAME_PLACE_M)) return { reason: "ambiguous" };
  return { object: best };
}

/** Area words that name the country or a region containing GR-I: not foreign, not an island either. */
const HOME_AREA_WORDS = ["greece", "griechenland", "grece", "grecia", "hellas", "ελλαδα", "attica", "attika", "attiki", "αττικη", "athens", "athen", "athina", "athenes", "atene", "αθηνα", "piraeus", "piräus", "pireas", "πειραιας", "peloponnese", "peloponnes", "peloponneso", "πελοποννησος", "argolis", "argolida", "argolic", "saronic", "saronischer", "saronico", "σαρωνικος", "aegean", "ägäis", "aigaio", "mediterranean", "mittelmeer"];

/**
 * A page area that names neither an island, a search area, a gazetteer object (GR-I/GR-J) nor the country or a
 * region around GR-I (review fix 3): a mention placed there must not land on a GR-I object of the same name.
 */
export function isForeignArea(area: string | null, gaz: GazObject[], knownAreas: string[]): boolean {
  if (!area || !normalizeName(area)) return false;
  if (islandOf(area, gaz)) return false;
  const a = normalizeName(area);
  if (HOME_AREA_WORDS.some((w) => a.split(" ").includes(w))) return false;
  if (knownAreas.some((k) => contains(k, area))) return false;
  return !gaz.some((g) => g.names.some((n) => contains(n, area)));
}

export function locateAll(mentions: Mention[], gaz: GazObject[], affixes: NameAffixesConfig, knownAreas: string[] = []): Located[] {
  return mentions.map((m) => {
    if (m.coordinate) return { ...m, method: "coordinate", lon: m.coordinate.lon, lat: m.coordinate.lat, reason: null, gazId: null };
    if (!m.name.trim()) return { ...m, method: null, lon: null, lat: null, reason: "no_name", gazId: null };
    if (isForeignArea(m.area, gaz, knownAreas)) return { ...m, method: null, lon: null, lat: null, reason: "foreign_area", gazId: null };
    const r = locateByGazetteer(m, gaz, affixes);
    if ("object" in r) return { ...m, method: "gazetteer", lon: r.object.lon, lat: r.object.lat, reason: null, gazId: r.object.id };
    return { ...m, method: null, lon: null, lat: null, reason: r.reason, gazId: null };
  });
}

/** `locate [--model]`: writes `located.jsonl` (all mentions, located or with a reason); `--model` adds the model pass. */
export const locateCommand: Command = async (args, dir) => {
  const flags = parseFlags(args);
  const gaz = await readGazetteer(dir);
  const mentions = await readJsonl<Mention>(dir, "mentions.jsonl");
  const knownAreas = ((await readJson<Area[]>(dir, "areas.json")) ?? []).flatMap((a) => Object.values(a.names).filter((n): n is string => !!n));
  let located = locateAll(mentions, gaz, getConfig().nameAffixes, knownAreas);
  // A paid model result of an earlier run is kept for a mention the name pass still cannot place (not for a foreign one).
  const previous = (await readJson<Located[]>(dir, "located.json")) ?? [];
  const modelHits = new Map(previous.filter((p) => p.method === "model").map((p) => [`${p.url}\n${p.name}\n${p.berthQuote}`, p]));
  located = located.map((l) => (l.method === null && l.reason !== "foreign_area" ? (modelHits.get(`${l.url}\n${l.name}\n${l.berthQuote}`) ?? l) : l));
  const count = (rows: Located[]) => {
    const out: Record<string, number> = {};
    for (const l of rows) {
      const k = l.method ?? `unresolved:${l.reason}`;
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  process.stdout.write(`${mentions.length} mentions: ${JSON.stringify(count(located))}\n`);
  if (flags.model) {
    const { locateByModel } = await import("./locate-model");
    const ledger = await CostLedger.open(dir);
    located = await locateByModel(ledger, dir, located, gaz);
    process.stdout.write(`after model pass: ${JSON.stringify(count(located))}; spent ${ledger.totalEur.toFixed(3)} EUR\n`);
  }
  await writeJson(dir, "located.json", located);
  await appendJsonl(dir, "locate-runs.jsonl", [{ at: new Date().toISOString(), model: !!flags.model, counts: count(located) }]);
};
