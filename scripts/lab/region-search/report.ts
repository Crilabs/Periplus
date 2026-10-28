import type { Metrics } from "./compare";

/*
 * The committed report (spec 5E/6): counts and quotas only. Our own URLs and domains may appear; nothing of the
 * reference does.
 */

export type ReportInput = {
  metrics: Metrics[];
  /** Located mentions outside the area's tiles (GR-J and beyond): not counted anywhere else. */
  outside: number;
  costs: { totalEur: number; byStage: Record<string, number>; capEur: number };
  counts: { queriesD: number; queriesC: number; hitsD: number; hitsC: number; pages: number; assessed: number; counting: number; mentions: number; dropped: number };
  topDomains: Array<{ domain: string; pages: number; mentions: number }>;
  generatedAt: Date;
};

const pct = (n: number, d: number): string => (d === 0 ? "–" : `${((100 * n) / d).toFixed(1).replace(".", ",")} %`);
const eur = (n: number): string => `${n.toFixed(2).replace(".", ",")} €`;

/** Spec 6, thresholds decided by Christian (28.10.): 40 % / 20 % of the bay clusters of "Kacheln GR-I". */
export function decision(m: Metrics): string {
  const share = m.clusters === 0 ? 0 : m.clustersConfirmedStrict300 / m.clusters;
  if (share >= 0.4) return "≥ 40 %: Quelle-zuerst als Pipeline-Stufe bauen; Tor auf Buchtebene mit 300 m neu fassen (T8).";
  if (share >= 0.2) return "20–40 %: bauen, aber das Abdeckungsziel gegen den neuen Nenner neu verhandeln; prüfen, welche Quellenklasse die Lücke schließt.";
  return "< 20 %: Das Web als alleinige Quellenklasse reicht nicht für das Ziel; andere Klassen prüfen, bevor weiter an Suche und Gerüst gearbeitet wird.";
}

export function renderReport(input: ReportInput): string {
  const { metrics, outside, costs, counts, topDomains, generatedAt } = input;
  const date = generatedAt.toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# P1 – Revier-Suche und Verortung aus Berichten (Attika 2)`, ``);
  lines.push(`Stand ${date}, erzeugt von \`scripts/lab/region-search\` (\`compare\`). Nur Zählungen und Quoten; die Referenz ist nie Datenquelle.`, ``);
  lines.push(`## Trichter`, ``);
  lines.push(`| Stufe | Zahl |`, `| --- | ---: |`);
  lines.push(`| Anfragen DataForSEO (D) / Gebiete Claude-Websuche (C) | ${counts.queriesD} / ${counts.queriesC} |`);
  lines.push(`| URLs aus D / aus C | ${counts.hitsD} / ${counts.hitsC} |`);
  lines.push(`| Seiten geholt / bewertet / zählend | ${counts.pages} / ${counts.assessed} / ${counts.counting} |`);
  lines.push(`| Nennungen (gültig) / verworfen | ${counts.mentions} / ${counts.dropped} |`);
  lines.push(`| davon verortet außerhalb der Kacheln von GR-I (GR-J und weiter) | ${outside} |`, ``);
  for (const m of metrics) {
    lines.push(`## Nenner „${m.denominator}“: ${m.spots} Spots, ${m.clusters} Bucht-Cluster (≤ 300 m)`, ``);
    lines.push(`| Kennzahl | Wert | Anteil |`, `| --- | ---: | ---: |`);
    lines.push(`| Spots mit Web-Ort ≤ 150 m | ${m.covered1["150"]} | ${pct(m.covered1["150"], m.spots)} |`);
    lines.push(`| Spots mit Web-Ort ≤ 300 m | ${m.covered1["300"]} | ${pct(m.covered1["300"], m.spots)} |`);
    lines.push(`| Spots mit Web-Ort ≤ 600 m | ${m.covered1["600"]} | ${pct(m.covered1["600"], m.spots)} |`);
    lines.push(`| Spots mit ≥ 2 unabhängigen Quellen ≤ 300 m (pipelinenah: erste Hand oder Revierführer) | ${m.confirmedStrict300} | ${pct(m.confirmedStrict300, m.spots)} |`);
    lines.push(`| Spots mit ≥ 2 unabhängigen Quellen ≤ 300 m (alle zählenden Seiten) | ${m.confirmedAll300} | ${pct(m.confirmedAll300, m.spots)} |`);
    lines.push(`| **Bucht-Cluster mit ≥ 2 unabhängigen Quellen ≤ 300 m (bindend)** | **${m.clustersConfirmedStrict300}** | **${pct(m.clustersConfirmedStrict300, m.clusters)}** |`);
    lines.push(`| dasselbe mit modellgestützter Verortung | ${m.clustersConfirmedStrict300WithModel} | ${pct(m.clustersConfirmedStrict300WithModel, m.clusters)} |`);
    lines.push(`| Web-Orte mit ≥ 2 Quellen ohne Spot ≤ 300 m (Konfliktlast) | ${m.conflicts300} | |`, ``);
    lines.push(`Gedeckte Spots (≤ 300 m) nach Suchweg: nur D ${m.byEngine.dOnly}, nur C ${m.byEngine.cOnly}, beide ${m.byEngine.both}. Nach Verortungsweg: ${Object.entries(m.byMethod).map(([k, v]) => `${k} ${v}`).join(", ") || "–"}.`, ``);
    lines.push(`Wörtliche Koordinaten: ${m.coordMentions.count} Nennungen, Median-Abstand zum nächsten Spot ${m.coordMentions.medianDistanceM === null ? "–" : `${m.coordMentions.medianDistanceM.toFixed(0)} m`}, davon ≤ 150 m: ${m.coordMentions.within150}.`, ``);
    lines.push(`Unverortete Nennungen: ${Object.entries(m.unresolved).map(([k, v]) => `${k} ${v}`).join(", ") || "keine"}; davon mit Lagebeschreibung ${m.unresolvedWithPosition}.`, ``);
  }
  const binding = metrics[0];
  if (binding) {
    lines.push(`## Entscheidungsregel (Spec 6)`, ``);
    lines.push(`Bindend: Bucht-Cluster „${binding.denominator}“ mit ≥ 2 unabhängigen Quellen ≤ 300 m: ${binding.clustersConfirmedStrict300} von ${binding.clusters} = ${pct(binding.clustersConfirmedStrict300, binding.clusters)}.`, ``);
    lines.push(`Folge: ${decision(binding)}`, ``);
  }
  lines.push(`## Tragende Domains (nach Nennungen)`, ``);
  lines.push(`| Domain | Seiten mit Nennung | Nennungen |`, `| --- | ---: | ---: |`);
  for (const d of topDomains) lines.push(`| ${d.domain} | ${d.pages} | ${d.mentions} |`);
  lines.push(``, `## Kosten`, ``);
  lines.push(`| Stufe | Kosten |`, `| --- | ---: |`);
  for (const [stage, v] of Object.entries(costs.byStage)) lines.push(`| ${stage} | ${eur(v)} |`);
  lines.push(`| **gesamt** | **${eur(costs.totalEur)}** (Obergrenze ${eur(costs.capEur)}) |`, ``);
  return lines.join("\n");
}
