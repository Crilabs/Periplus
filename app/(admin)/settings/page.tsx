import { getConfig, type AppConfig } from "@/lib/config";
import { getFactSchema } from "@/lib/domain/facts/schema";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import { requireAdmin } from "@/lib/security/require-admin";

const LEVEL_LABELS: Record<FactLevel, string> = {
  place: "Ort",
  area: "Revier",
  island: "Insel",
  cape_strait: "Kap/Enge",
  poi: "POI",
};

const EFFORT_LABELS = { low: "niedrig", medium: "mittel", high: "hoch" } as const;

/** Parameter groups of the consolidation rules version, in display order. */
const CONSOLIDATION_GROUPS: Record<Exclude<keyof AppConfig["consolidation"], "version" | "rules">, string> = {
  recency: "Aktualität",
  precision: "Nachkommastellen",
  weights: "Gewichte ohne Quelle",
  poiConfidence: "Konfidenz POI",
  confidence: "Konfidenz",
  conflict: "Konflikt",
  change: "Änderung",
  expiry: "Ablauf",
  profileConfidence: "Profil-Konfidenz",
  profileConfidenceGroups: "Profil-Konfidenz: Attribute je Gruppe",
  quietness: "Ruhe",
  importance: "Bedeutung",
  severity: "Schwere",
  gaps: "Lücken",
  followup: "Folgeaufträge",
  summary: "Zusammenfassung",
};

/** Flattens parameters to `a.b: value` pairs for a read-only table cell. */
function parameterText(value: unknown, prefix = ""): string[] {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([k, v]) => parameterText(v, prefix ? `${prefix}.${k}` : k));
  }
  const shown = Array.isArray(value) ? `[${value.map((v) => JSON.stringify(v)).join(", ")}]` : String(value);
  return [prefix ? `${prefix}: ${shown}` : shown];
}

export default async function Page() {
  await requireAdmin();
  const { areas, gazetteer, ...rest } = getConfig();
  const { geometry, factSchema, fetch, embeddings, models, consolidation } = rest;
  const exceptions = Object.entries(fetch.converterBySource);
  const archiveRows: [string, string][] = [
    [
      "Konverter-Entscheidung",
      `${fetch.decision.status === "decided" ? "Entschieden" : "Vorläufig"}: ${fetch.decision.note}`,
    ],
    ["Standard-Konverter", fetch.defaultConverter],
    ["Konverter je Quelle", exceptions.length > 0 ? exceptions.map(([d, c]) => `${d} → ${c}`).join(", ") : "keine Ausnahmen"],
    [
      "PDF-Extraktor",
      `${fetch.pdf.extractor}${fetch.pdf.modelFallback ? `, Claude für unlesbare Seiten (höchstens ${fetch.pdf.maxModelPagesPerDocument} je Dokument)` : ""}`,
    ],
    ["Embedding-Modell", `${embeddings.provider} ${embeddings.model}, Dimension ${embeddings.dimension}`],
  ];
  const geometryRows: [string, string][] = [
    ["Regelversion", geometry.rulesVersion],
    ["Fact-Schema-Version", factSchema.version],
    ["Strahlen", `${geometry.fetch.rayCount} im ${geometry.fetch.rayStepDeg}°-Abstand, bis ${geometry.fetch.maxRayM} m`],
    ["Schutz voll bis Fetch", `${geometry.shelter.fMinM} m`],
    ["Kein Schutz ab Fetch", `${geometry.shelter.fMaxM} m`],
    ["Sektor-Schutz", `${geometry.shelter.meanWeight} × Mittelwert + ${geometry.shelter.minWeight} × Minimum`],
    ["Öffnung zur See ab Fetch", `${geometry.opening.openFetchM} m`],
    [
      "Schwell",
      `Quelle ab ${geometry.swell.longFetchM} m Fetch; Öffnung (Fetch > ${geometry.swell.openFetchM} m) breiter als ${geometry.swell.maxOpeningDeg}° → × ${geometry.swell.wideOpeningFactor}; ohne Quelle ${geometry.swell.noSourceValue}`,
    ],
    [
      "Konfidenz",
      `Fetch ${geometry.fetch.confidence}, Schutz ${geometry.shelter.confidence}, Öffnung ${geometry.opening.confidence}, Schwell ${geometry.swell.confidence}`,
    ],
  ];
  const factSchemaLevels = getFactSchema(factSchema.version).levels;
  const factSchemaRows: [string, string][] = [
    ["Aktive Version", factSchema.version],
    ...(Object.keys(LEVEL_LABELS) as FactLevel[]).map((level): [string, string] => {
      const defs = factSchemaLevels[level];
      const fromText = defs.filter((d) => d.origins.includes("text")).length;
      return [LEVEL_LABELS[level], `${defs.length} Attribute, davon ${fromText} aus Texten`];
    }),
  ];
  const consolidationRows: [string, string][] = [
    ["Regelversion", consolidation.version],
    ...Object.entries(consolidation.rules).map(([rule, params]): [string, string] => [
      `Regel ${rule}`,
      parameterText(params).join("; "),
    ]),
    ...(Object.keys(CONSOLIDATION_GROUPS) as (keyof typeof CONSOLIDATION_GROUPS)[]).map((group): [string, string] => [
      CONSOLIDATION_GROUPS[group],
      parameterText(consolidation[group]).join("; "),
    ]),
  ];
  const thresholds: [string, string][] = [
    ["Puffer Kachelbox", `${gazetteer.bboxBufferKm} km`],
    ["Puffer Land", `${gazetteer.landBufferKm} km`],
    ["Küstenabstand", `${gazetteer.coastDistanceM} m`],
    ["Puffer Insel-Elternobjekt", `${gazetteer.islandParentBufferM} m`],
    ["Max. Fläche OSM-Küstenabschnitt als Elternobjekt", `${gazetteer.coastSectionMaxAreaKm2} km²`],
    ["Trigramm-Ähnlichkeit (sicher)", String(gazetteer.merge.trigramMin)],
    ["Trigramm-Ähnlichkeit (unsicher)", String(gazetteer.merge.uncertainTrigramMin)],
    [
      "Zusammenführungsabstand",
      Object.entries(gazetteer.merge.distanceM)
        .map(([type, m]) => `${type === "default" ? "sonst" : type} ${m} m`)
        .join(", "),
    ],
    ["Faktor Abstand (unsicher)", String(gazetteer.merge.uncertainDistanceFactor)],
    ["Wikidata-Verknüpfung bis", `${gazetteer.merge.wikidataLinkDistanceM} m`],
    ["GeoNames neues Objekt ab", `${gazetteer.merge.geonamesNewObjectRadiusM} m`],
    ["Overpass", `${gazetteer.overpass.timeoutSeconds} s Timeout, ${gazetteer.overpass.ratePerMinute}/min`],
    ["Wikidata", `${gazetteer.wikidata.ratePerMinute}/min, Sprachen ${gazetteer.wikidata.languages.join(", ")}`],
    ["GeoNames", `${gazetteer.geonames.countries.join(", ")}, alle ${gazetteer.geonames.refreshDays} Tage`],
    ["Kein Ankern bei", gazetteer.noAnchoringKinds.join(", ")],
  ];
  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-lg font-semibold">Einstellungen</h1>

      <h2 className="font-semibold">Reviere</h2>
      <table className="w-full text-left">
        <thead>
          <tr className="border-b">
            <th className="py-1 pr-4">Key</th>
            <th className="py-1 pr-4">Namen</th>
            <th className="py-1 pr-4">Kachelbox</th>
            <th className="py-1 pr-4">Zyklus</th>
            <th className="py-1 pr-4">Küstenabschnitte</th>
          </tr>
        </thead>
        <tbody>
          {areas.map((area) => (
            <tr key={area.key} className="border-b align-top">
              <td className="py-1 pr-4 font-mono">{area.key}</td>
              <td className="py-1 pr-4">
                {Object.entries(area.names)
                  .map(([lang, name]) => `${lang}: ${name}`)
                  .join(" · ")}
              </td>
              <td className="py-1 pr-4 font-mono">{area.tileBbox ? area.tileBbox.join(", ") : "keine"}</td>
              <td className="py-1 pr-4">{area.cycleDays} Tage</td>
              <td className="py-1 pr-4">{area.coastSections.map((s) => s.names.de).join(", ") || "keine"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="font-semibold">Gazetteer-Schwellen</h2>
      <table className="text-left">
        <tbody>
          {thresholds.map(([label, value]) => (
            <tr key={label} className="border-b">
              <th className="py-1 pr-4 font-normal">{label}</th>
              <td className="py-1 pr-4">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="font-semibold">Geometrie und Schutz</h2>
      <table className="text-left">
        <tbody>
          {geometryRows.map(([label, value]) => (
            <tr key={label} className="border-b">
              <th className="py-1 pr-4 font-normal">{label}</th>
              <td className="py-1 pr-4">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="font-semibold">Fact-Schema</h2>
      <table className="text-left">
        <tbody>
          {factSchemaRows.map(([label, value]) => (
            <tr key={label} className="border-b">
              <th className="py-1 pr-4 font-normal">{label}</th>
              <td className="py-1 pr-4">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="font-semibold">Konsolidierung</h2>
      <table className="text-left">
        <tbody>
          {consolidationRows.map(([label, value]) => (
            <tr key={label} className="border-b align-top">
              <th className="py-1 pr-4 font-normal">{label}</th>
              <td className="py-1 pr-4 font-mono">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="font-semibold">Modelle je Aufgabe</h2>
      <table className="text-left">
        <thead>
          <tr className="border-b">
            <th className="py-1 pr-4">Aufgabe</th>
            <th className="py-1 pr-4">Modell</th>
            <th className="py-1 pr-4">Prompt</th>
            <th className="py-1 pr-4">Aufwand</th>
            <th className="py-1 pr-4">Max. Token</th>
            <th className="py-1 pr-4">Entscheidung</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(models.tasks).map(([task, t]) => (
            <tr key={task} className="border-b align-top">
              <td className="py-1 pr-4 font-mono">{task}</td>
              <td className="py-1 pr-4 font-mono">{t.model}</td>
              <td className="py-1 pr-4">v{t.promptVersion}</td>
              <td className="py-1 pr-4">{EFFORT_LABELS[t.effort]}</td>
              <td className="py-1 pr-4">
                {t.maxTokens}
                {t.cacheSystem ? ", System-Prompt gecacht" : ""}
              </td>
              <td className="py-1 pr-4">
                {t.decision
                  ? `${t.decision.status === "decided" ? "Entschieden" : "Vorläufig"}: ${t.decision.note}`
                  : "–"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Batch-Rabatt {models.batch.discount}, Abfrage alle {models.batch.pollSeconds} s, Abbruch nach{" "}
        {models.batch.maxHours} h, höchstens {models.batch.maxRequests} Anfragen je Batch. Modellvergleich:{" "}
        {models.comparison.models.join(", ")}.
      </p>

      <h2 className="font-semibold">Quellen und Archiv</h2>
      <table className="text-left">
        <tbody>
          {archiveRows.map(([label, value]) => (
            <tr key={label} className="border-b">
              <th className="py-1 pr-4 font-normal">{label}</th>
              <td className="py-1 pr-4">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="font-semibold">Aktive Konfiguration</h2>
      {Object.entries(rest).map(([name, value]) => (
        <section key={name}>
          <h3 className="mb-1 font-mono">{name}</h3>
          <pre className="overflow-x-auto rounded bg-neutral-100 p-3">{JSON.stringify(value, null, 2)}</pre>
        </section>
      ))}
    </div>
  );
}
