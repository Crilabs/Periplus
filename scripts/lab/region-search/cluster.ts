import { distanceM } from "../../../lib/domain/gazetteer/rings";
import { copiesSource } from "../../../lib/domain/research/verbatim";
import type { Located } from "./locate";

/*
 * Spec 5D: located mentions become web places (greedy clustering within a radius); per web place the independent
 * sources are counted like the pipeline's confirmation (one per registrable domain, copies merged).
 */

export type WebPlace = {
  id: number;
  lon: number;
  lat: number;
  mentions: Located[];
  sourcesStrict: number;
  sourcesAll: number;
  methods: Record<string, number>;
  engines: { d: boolean; c: boolean };
};

const METHOD_ORDER: Record<string, number> = { coordinate: 0, gazetteer: 1, model: 2 };

/** Pipeline-near rule (spec 5D): first-hand pages and pilot guides count; everything else only when `strict` is off. */
export function countsAsSource(l: Located, strict: boolean): boolean {
  return !strict || l.firstHand || l.pageKind === "pilot_guide";
}

export function independentSources(mentions: Located[], copyMinSharedWords: number, strict: boolean): number {
  const counted = mentions.filter((m) => countsAsSource(m, strict));
  const domains = [...new Set(counted.map((m) => m.domain))];
  const parent = new Map(domains.map((d) => [d, d]));
  const find = (d: string): string => {
    const p = parent.get(d)!;
    if (p === d) return d;
    const root = find(p);
    parent.set(d, root);
    return root;
  };
  for (const a of counted) {
    for (const b of counted) {
      if (a.domain === b.domain) continue;
      if (copiesSource(a.berthQuote, b.berthQuote, copyMinSharedWords)) parent.set(find(a.domain), find(b.domain));
    }
  }
  return new Set(domains.map(find)).size;
}

export function clusterLocated(located: Located[], radiusM: number, opts: { copyMinSharedWords?: number; engineOf?: (url: string) => { d: boolean; c: boolean } } = {}): WebPlace[] {
  const copyWords = opts.copyMinSharedWords ?? 12;
  const engineOf = opts.engineOf ?? (() => ({ d: false, c: false }));
  const rows = located.filter((l): l is Located & { lon: number; lat: number } => l.lon !== null && l.lat !== null).sort((a, b) => (METHOD_ORDER[a.method ?? ""] ?? 9) - (METHOD_ORDER[b.method ?? ""] ?? 9));
  const clusters: Array<{ lon: number; lat: number; mentions: Located[] }> = [];
  for (const l of rows) {
    const c = clusters.find((k) => distanceM(k, l) <= radiusM);
    if (c) {
      c.mentions.push(l);
      c.lon = c.mentions.reduce((s, m) => s + m.lon!, 0) / c.mentions.length;
      c.lat = c.mentions.reduce((s, m) => s + m.lat!, 0) / c.mentions.length;
    } else clusters.push({ lon: l.lon, lat: l.lat, mentions: [l] });
  }
  return clusters.map((c, i) => {
    const methods: Record<string, number> = {};
    const engines = { d: false, c: false };
    for (const m of c.mentions) {
      methods[m.method ?? "?"] = (methods[m.method ?? "?"] ?? 0) + 1;
      const e = engineOf(m.url);
      engines.d ||= e.d;
      engines.c ||= e.c;
    }
    return { id: i + 1, lon: c.lon, lat: c.lat, mentions: c.mentions, sourcesStrict: independentSources(c.mentions, copyWords, true), sourcesAll: independentSources(c.mentions, copyWords, false), methods, engines };
  });
}
