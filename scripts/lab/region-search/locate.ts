import { getConfig, type NameAffixesConfig } from "../../../lib/config";
import { distanceM } from "../../../lib/domain/gazetteer/rings";
import { berthNameMatches } from "../../../lib/domain/research/assign";
import { parseFlags, type Command } from "./cli";
import { CostLedger } from "./costs";
import type { Mention } from "./extract";
import { readGazetteer, type GazObject } from "./gazetteer";
import { appendJsonl, readJsonl, writeJson } from "./store";

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

export function locateByGazetteer(m: Mention, gaz: GazObject[], affixes: NameAffixesConfig): { object: GazObject } | { reason: "no_match" | "ambiguous" } {
  const names = [m.name, ...m.aliases];
  const hits = gaz.filter((g) => names.some((n) => berthNameMatches({ name: n, island: m.area }, g.names, affixes, g.islandName ? [g.islandName] : [])));
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

export function locateAll(mentions: Mention[], gaz: GazObject[], affixes: NameAffixesConfig): Located[] {
  return mentions.map((m) => {
    if (m.coordinate) return { ...m, method: "coordinate", lon: m.coordinate.lon, lat: m.coordinate.lat, reason: null, gazId: null };
    if (!m.name.trim()) return { ...m, method: null, lon: null, lat: null, reason: "no_name", gazId: null };
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
  let located = locateAll(mentions, gaz, getConfig().nameAffixes);
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
