import type { Metadata } from "next";
import { getConfig, type AppConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { listApiClients } from "@/lib/domain/api-clients";
import { loadAreaFiles } from "@/lib/domain/areas/file";
import { activationOf, consolidationConfigFor, extractionVersion } from "@/lib/domain/consolidation/active-rules";
import { getFactSchema } from "@/lib/domain/facts/schema";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import { countryName } from "@/lib/domain/subdivisions/view";
import { requireAdmin } from "@/lib/security/require-admin";
import { Dialog } from "../_components/dialog";
import { GEO_OBJECT_TYPE_LABELS, METRIC_LABELS } from "../_components/labels";
import {
  Badge,
  Button,
  cx,
  DescriptionList,
  EmptyState,
  fmt,
  Mono,
  Notice,
  PageHeader,
  Panel,
  Table,
  tdClass,
  thClass,
  trClass,
} from "../_components/ui";
import { revokeApiClientAction } from "./actions";

export const metadata: Metadata = { title: "Einstellungen" };

const LEVEL_LABELS: Record<FactLevel, string> = {
  place: "Ort",
  area: "Revier",
  island: "Insel",
  cape_strait: "Kap/Enge",
  poi: "Highlight",
};

const EFFORT_LABELS = { low: "niedrig", medium: "mittel", high: "hoch" } as const;

/** Parameter groups of the consolidation rules version, in display order. */
const CONSOLIDATION_GROUPS: Record<Exclude<keyof AppConfig["consolidation"], "version" | "rules">, string> = {
  recency: "Aktualität",
  precision: "Nachkommastellen",
  weights: "Gewichte ohne Quelle",
  poiConfidence: "Konfidenz Highlight",
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

/** Parameter groups of the delivery configuration, in display order. */
const DELIVERY_GROUPS: Record<Exclude<keyof AppConfig["delivery"], "schemaVersion" | "forbiddenDomains" | "licenses">, string> = {
  build: "Paketbau",
  spots: "Spots",
  coast: "Küste",
  regions: "Regionen",
  weather: "Wetterpunkte",
  highlights: "Highlights",
  validation: "Validierung",
  severity: "Schwere",
  api: "API",
};

/** A target of `config/quality.json` in German: shares as percent, cost in euro, review effort in minutes. */
function targetText(metric: keyof AppConfig["quality"]["targets"], value: number): string {
  if (metric === "cost_per_place") return value.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
  if (metric === "review_minutes_per_100") return `${value.toLocaleString("de-DE")} Min.`;
  return value.toLocaleString("de-DE", { style: "percent", maximumFractionDigits: 1 });
}

/** Flattens parameters to `a.b: value` pairs for a read-only table cell. */
function parameterText(value: unknown, prefix = ""): string[] {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([k, v]) => parameterText(v, prefix ? `${prefix}.${k}` : k));
  }
  const shown = Array.isArray(value) ? `[${value.map((v) => JSON.stringify(v)).join(", ")}]` : String(value);
  return [prefix ? `${prefix}: ${shown}` : shown];
}

export default async function Page({ searchParams }: PageProps<"/settings">) {
  await requireAdmin();
  const revoked = (await searchParams).notice === "api_client_revoked";
  const db = getDb();
  const apiClients = await listApiClients(db);
  const { gazetteer, ...configured } = getConfig();
  const subdivisionsCfg = configured.subdivisions;
  const areasCfg = configured.areas;
  const areaFiles = await loadAreaFiles();
  const areaRows: [string, string][] = [
    ["Mindestens aufgelöste Mitglieder", `${areasCfg.minMembers} (darunter „wartet auf Gazetteer“)`],
    [
      "Polygon",
      `Puffer ${areasCfg.polygon.bufferNm} sm, konkave Hülle ${areasCfg.polygon.concaveRatio}, höchstens ${areasCfg.polygon.inlandCutM} m ins Land, Golf deckt ab ${areasCfg.polygon.gulfCoverShare}`,
    ],
    ["Nachbarring Nachlesen", `${areasCfg.neighbourRing} Kachel(n)`],
    [
      "Mitgliedstypen",
      Object.entries(areasCfg.memberTypes)
        .map(([type, order]) => `${type} → ${order.join(" vor ")}`)
        .join("; "),
    ],
    [
      "Alte Schlüssel",
      Object.entries(areasCfg.aliases).map(([from, to]) => `${from} → ${to}`).join(", ") || "keine",
    ],
  ];
  // the active rules version: the newest released activation, else active.json (ruling M7-P10)
  const consolidation = await consolidationConfigFor(db);
  const rulesActivation = await activationOf(db, "consolidation_rules", consolidation.version);
  const rest = { ...configured, consolidation };
  const { geometry, factSchema, fetch, embeddings, models, delivery, quality, images } = rest;
  const extractFacts = models.tasks["extract-facts"];
  const extractionApproval = extractFacts
    ? await activationOf(db, "extraction", extractionVersion({ model: extractFacts.model, promptVersion: extractFacts.promptVersion }))
    : null;
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
    ["Einbettungsmodell", `${embeddings.provider} ${embeddings.model}, Dimension ${embeddings.dimension}`],
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
    [
      "Unbenannte Buchten",
      `Küste alle ${geometry.bays.coastStepM} m, Prüfpunkt ${geometry.bays.probeOffsetM} m vor der Küste; ≥ ${geometry.bays.minLandDeg}° Land in ${geometry.bays.rayLengthM} m; Ankerfläche ≥ ${geometry.bays.minAnchorAreaM2} m²; zusammengefasst unter ${geometry.bays.mergeDistanceM} m, geteilt über ${geometry.bays.maxClusterSpanM} m; bekannt bei Ort oder ${geometry.bays.knownObjectTypes.map((t) => GEO_OBJECT_TYPE_LABELS[t]).join("/")} in ${geometry.bays.knownPlaceDistanceM} m, eigene Bucht eines bekannten Orts bis ${geometry.bays.knownBayDistanceM} m; Hilfsname nach ${geometry.bays.helperNameTypes.map((tier) => tier.map((t) => GEO_OBJECT_TYPE_LABELS[t]).join(", ")).join(" vor ")} in ${geometry.bays.helperNameMaxDistanceM} m`,
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
  const deliveryRows: [string, string][] = [
    ["Vertragsversion", delivery.schemaVersion],
    ...(Object.keys(DELIVERY_GROUPS) as (keyof typeof DELIVERY_GROUPS)[]).map((group): [string, string] => [
      DELIVERY_GROUPS[group],
      parameterText(delivery[group]).join("; "),
    ]),
    ["Verbotene Domains", delivery.forbiddenDomains.join(", ")],
    ...delivery.licenses.map((l): [string, string] => [
      `Lizenz ${l.name}`,
      `${l.attribution} (${l.url}); Dateien: ${l.files.join(", ") || "keine"}; Felder: ${l.fields.join(", ") || "keine"}`,
    ]),
  ];
  const imageRows: [string, string][] = [
    ["Quellen", Object.entries(images.sources).map(([name, s]) => `${name} (${s.kind === "wms" ? "Luftbild" : "Gelände"}, ${s.resolutionM} m, ${s.countries === "*" ? "alle Länder" : s.countries.join(", ")})`).join("; ")],
    ["Lieferung je Quelle", Object.entries(images.delivery).map(([name, on]) => `${name}: ${on ? "geliefert" : "nicht geliefert"}`).join(", ")],
    ["Kamera", `Neigung ${images.camera.tiltDeg}°, Bildwinkel ${images.camera.fovDeg}°, ${images.camera.width} × ${images.camera.height}, Drehschritt ${images.camera.rotateStepDeg}°, Standard ${images.camera.defaultZoom}`],
    ["Zoomstufen", Object.entries(images.camera.zooms).map(([z, v]) => `${z} ${v.heightM} m`).join(", ")],
    ["Licht", `Stadt im Umkreis ${images.light.townRadiusM} m: ${images.light.nearTown}; je Art ${Object.entries(images.light.byKind).map(([k, v]) => `${k} ${v}`).join(", ")}`],
    ["Wasser-IoU mindestens", `Mittag ${images.check.minWaterIoU.midday}, Abend ${images.check.minWaterIoU.evening}; höchstens ${images.check.maxAttempts} Versuche`],
    ["Je Lauf höchstens", `${images.pipeline.maxGenerationsPerRun} Bilder (pipeline.maxGenerationsPerRun)`],
    ["Ausgabe", `JPEG ${images.output.jpegQuality}, Lizenz ${images.output.license}, ${images.output.credit}`],
  ];
  const qualityRows: [string, string][] = [
    ...(Object.keys(quality.targets) as (keyof typeof quality.targets)[]).map((metric): [string, string] => {
      const t = quality.targets[metric];
      const bound = t.direction === "min" ? "mindestens" : "höchstens";
      const parts = [
        t.pilot === null ? "kein Pilotziel" : `${bound} ${targetText(metric, t.pilot)} im Pilot`,
        t.full === null ? "kein Ziel im Vollbetrieb" : `${bound} ${targetText(metric, t.full)} im Vollbetrieb`,
      ];
      return [METRIC_LABELS[metric], parts.join(", ")];
    }),
    ["Review-Aufwand zweiter Lauf (Pilot)", `unter ${quality.secondRunReviewMinutesMax} Min.`],
    ["Orte je Kachel", `${quality.placesPerTile.min}–${quality.placesPerTile.max}`],
    [
      "Vergleichssatz",
      `${quality.comparisonSet.pilotSize} Orte im Pilot, ${quality.comparisonSet.perSubdivisionMin}–${quality.comparisonSet.perSubdivisionMax} je weiterem Landesteil`,
    ],
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
    ["GeoNames", `Land des Landesteils, alle ${gazetteer.geonames.refreshDays} Tage`],
    ["Kein Ankern bei", gazetteer.noAnchoringKinds.join(", ")],
  ];
  return (
    <>
      <PageHeader
        title="Einstellungen"
        description="Die aktive Konfiguration aus config/, nur zum Lesen. Änderungen laufen über die Dateien im Repository und einen Deploy."
        actions={
          <Dialog
            trigger="Aktive Konfiguration (JSON)"
            title="Aktive Konfiguration"
            description="Alle geladenen Konfigurationsbereiche außer dem Gazetteer, so wie die Pipeline sie sieht."
            wide
          >
            <div className="space-y-2">
              {Object.entries(rest).map(([name, value]) => (
                <details key={name} className="rounded-md border border-line">
                  <summary className="cursor-pointer px-3 py-2 font-mono text-[0.8125rem] hover:bg-sunken/50">{name}</summary>
                  <pre className="overflow-x-auto border-t border-line bg-sunken p-3 text-xs leading-relaxed">
                    {JSON.stringify(value, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
          </Dialog>
        }
      />

      <Panel
        title="Länder und Landesteile"
        description={`Wie Landesteile aus den Verwaltungseinheiten der Mittelmeerländer entstehen (config/subdivisions.json): Ebene der Einheiten in OSM, Quellsprachen, Saison und Zyklus je Land. Dazu ${subdivisionsCfg.split.length} Teilungen, ${subdivisionsCfg.merge.length} Zusammenlegungen, ${subdivisionsCfg.extra.length} zusätzliche Einheiten, ${subdivisionsCfg.notMediterranean.length} ausgenommene Einheiten ohne Mittelmeerküste und ${Object.keys(subdivisionsCfg.overrides).length} Abweichungen je Landesteil.`}
        className="mb-6"
        flush
      >
        <Table>
          <thead>
            <tr>
              <th className={thClass}>Land</th>
              <th className={thClass}>Ebene</th>
              <th className={thClass}>Quellsprachen</th>
              <th className={thClass}>Saison</th>
              <th className={`${thClass} text-right`}>Zyklus</th>
              <th className={thClass}>Status</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(subdivisionsCfg.countries)
              .sort(([a], [b]) => countryName(a).localeCompare(countryName(b), "de"))
              .map(([code, c]) => (
                <tr key={code} className={trClass}>
                  <td className={tdClass}>
                    <span className="font-medium">{countryName(code)}</span> <Mono>{code}</Mono>
                  </td>
                  <td className={tdClass}>
                    {c.firstLevel === "whole" || subdivisionsCfg.wholeCountry.includes(code)
                      ? "als Ganzes"
                      : `admin_level ${c.firstLevel}${c.secondLevel ? `, Teilung ${c.secondLevel}` : ""}`}
                  </td>
                  <td className={tdClass}>{c.sourceLanguages.join(", ")}</td>
                  <td className={cx(tdClass, "whitespace-nowrap tabular-nums")}>
                    {c.season.fromMonth}–{c.season.toMonth}
                  </td>
                  <td className={cx(tdClass, "text-right whitespace-nowrap tabular-nums")}>{c.cycleDays} Tage</td>
                  <td className={tdClass}>
                    {c.status === "excluded" ? <span className="text-danger">ausgeschlossen: {c.statusReason}</span> : <span className="text-muted">aktiv</span>}
                  </td>
                </tr>
              ))}
          </tbody>
        </Table>
      </Panel>

      <Panel
        title="Reviere"
        description="Reviere liefert der Revier-Bot als Datei je Land (config/area-imports/); Periplus übernimmt seinen Stand, Korrekturen passieren dort. Import: npm run areas:import. Werte aus config/areas.json."
        className="mb-6"
      >
        <Pairs rows={areaRows} />
        <div className="mt-4 border-t border-line pt-4">
          {areaFiles.length === 0 ? (
            <p className="text-sm text-muted">Noch keine Datei des Revier-Bots in config/area-imports/.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={thClass}>Land</th>
                  <th className={thClass}>Stand der Datei</th>
                  <th className={`${thClass} text-right`}>Reviere</th>
                </tr>
              </thead>
              <tbody>
                {areaFiles.map((f) => (
                  <tr key={f.country} className={trClass}>
                    <td className={tdClass}>
                      <span className="font-medium">{countryName(f.country)}</span> <Mono>{f.country}</Mono>
                    </td>
                    <td className={cx(tdClass, "whitespace-nowrap tabular-nums")}>{f.generatedAt}</td>
                    <td className={cx(tdClass, "text-right tabular-nums")}>{f.areas.length}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Panel>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel
          title="Gazetteer-Schwellen"
          description="Wie der Gazetteer-Lauf Objekte aus OSM, Wikidata und GeoNames sammelt und gleiche Objekte zusammenführt (config/gazetteer.json)."
        >
          <Pairs rows={thresholds} />
        </Panel>

        <Panel
          title="Geometrie und Schutz"
          description="Wie der Geometrie-Lauf je Ort Fetch, Schutz, Öffnung zur See und Schwell aus Tiefen- und Landdaten berechnet (config/geometry.json)."
        >
          <Pairs rows={geometryRows} />
        </Panel>

        <Panel
          title="Fact-Schema"
          description="Welche Attribute je Ebene erfasst werden. „Aus Texten“: Attribute, die aus Quellentexten extrahiert werden können."
        >
          <Pairs rows={factSchemaRows} />
        </Panel>

        <Panel
          title="Quellen und Archiv"
          description="Wie Quellseiten in Text umgewandelt und für die Suche eingebettet werden."
        >
          <Pairs rows={archiveRows} />
        </Panel>

        <Panel
          title="Konsolidierung"
          description="Regeln, nach denen aus einzelnen Facts die Profile der Orte werden: Aktualität, Gewichte, Konfidenz, Konflikte, Lücken."
          actions={
            <Dialog trigger="Alle Parameter" triggerSize="sm" title="Konsolidierung" description={`Regelversion ${consolidation.version}`} wide>
              <Pairs rows={consolidationRows} mono />
            </Dialog>
          }
        >
          <Pairs
            rows={[
              ["Regelversion", consolidation.version],
              [
                "Aktiv durch",
                rulesActivation
                  ? `Aktivierung am ${fmt.dateTime(rulesActivation.activatedAt)} von ${rulesActivation.activatedBy} (Qualität → Regression)`
                  : "config/consolidation/active.json",
              ],
              ["Regeln", Object.keys(consolidation.rules).join(", ")],
            ]}
          />
        </Panel>

        <Panel
          title="Titelbilder"
          description="Wie KI-Titelbilder der Orte entstehen: Luftbildquellen, Kamera, Licht, Prüfschwellen und Lieferung je Quelle (config/images.json)."
        >
          <Pairs rows={imageRows} />
        </Panel>

        <Panel
          title="Qualitätsziele"
          description="Zielwerte der Qualitätskennzahlen für Pilot und Vollbetrieb (config/quality.json)."
        >
          <Pairs rows={qualityRows} />
        </Panel>

        <Panel
          title="Lieferung"
          description="Parameter des Liefervertrags: was an Spots, Küste, Regionen, Wetterpunkten und Highlights ausgeliefert wird, mit Lizenzen."
          actions={
            <Dialog trigger="Alle Parameter" triggerSize="sm" title="Lieferung" description={`Vertragsversion ${delivery.schemaVersion}`} wide>
              <Pairs rows={deliveryRows} mono />
            </Dialog>
          }
        >
          <Pairs
            rows={[
              ["Vertragsversion", delivery.schemaVersion],
              ["Lizenzen", delivery.licenses.map((l) => l.name).join(", ") || "keine"],
            ]}
          />
        </Panel>
      </div>

      <Panel
        id="api-clients"
        title="API-Clients"
        description="Abnehmer, die Pakete über die Liefer-API abrufen. Anlegen per CLI (npm run apikey:create -- <name> --scope delivery:read); der Schlüssel wird nur dabei einmal angezeigt. „Sperren“ wirkt sofort und lässt sich nicht zurücknehmen."
        className="mt-6"
        flush
      >
        {revoked && (
          <div className="border-b border-line p-4">
            <Notice tone="ok">API-Client gesperrt. Sein Schlüssel wird ab sofort abgewiesen.</Notice>
          </div>
        )}
        {apiClients.length === 0 ? (
          <EmptyState title="Noch kein API-Client">Mit npm run apikey:create -- &lt;name&gt; --scope delivery:read anlegen.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={thClass}>Name</th>
                <th className={thClass}>Rechte</th>
                <th className={`${thClass} text-right`}>Anfragen/Min.</th>
                <th className={thClass}>Angelegt</th>
                <th className={thClass}>Status</th>
                <th className={thClass}>
                  <span className="sr-only">Aktion</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {apiClients.map((c) => (
                <tr key={c.id} className={trClass}>
                  <td className={cx(tdClass, "font-medium")}>{c.name}</td>
                  <td className={tdClass}>
                    <Mono>{c.scopes.join(", ") || "keine"}</Mono>
                  </td>
                  <td className={cx(tdClass, "text-right tabular-nums")}>{c.rateLimitPerMin}</td>
                  <td className={cx(tdClass, "whitespace-nowrap")}>{fmt.date(c.createdAt)}</td>
                  <td className={tdClass}>
                    {c.revokedAt ? <Badge>Gesperrt seit {fmt.date(c.revokedAt)}</Badge> : <Badge tone="ok">Aktiv</Badge>}
                  </td>
                  <td className={cx(tdClass, "text-right")}>
                    {!c.revokedAt && (
                      <Dialog
                        trigger="Sperren"
                        triggerVariant="danger"
                        triggerSize="sm"
                        title={`API-Client „${c.name}“ sperren?`}
                        description="Sein Schlüssel wird ab sofort abgewiesen. Für den Abnehmer muss danach per CLI ein neuer Client angelegt werden."
                      >
                        <form action={revokeApiClientAction} className="flex justify-end">
                          <input type="hidden" name="id" value={c.id} />
                          <Button variant="danger">Endgültig sperren</Button>
                        </form>
                      </Dialog>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel
        title="Modelle je Aufgabe"
        description={`Welches Modell und welche Prompt-Version jede KI-Aufgabe nutzt. Batches: Rabatt ${models.batch.discount}, Abfrage alle ${models.batch.pollSeconds} s, Abbruch nach ${models.batch.maxHours} h, höchstens ${models.batch.maxRequests} Anfragen je Batch. Modellvergleich: ${models.comparison.models.join(", ")}.`}
        className="mt-6"
        flush
      >
        <Table>
          <thead>
            <tr>
              <th className={thClass}>Aufgabe</th>
              <th className={thClass}>Modell</th>
              <th className={thClass}>Prompt</th>
              <th className={thClass}>Aufwand</th>
              <th className={`${thClass} text-right`}>Max. Token</th>
              <th className={thClass}>Entscheidung</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(models.tasks).map(([task, t]) => (
              <tr key={task} className={trClass}>
                <td className={tdClass}>
                  <Mono>{task}</Mono>
                </td>
                <td className={tdClass}>
                  <Mono>{t.model}</Mono>
                </td>
                <td className={cx(tdClass, "tabular-nums")}>v{t.promptVersion}</td>
                <td className={tdClass}>{EFFORT_LABELS[t.effort]}</td>
                <td className={cx(tdClass, "text-right tabular-nums")}>
                  {t.maxTokens.toLocaleString("de-DE")}
                  {t.cacheSystem && <div className="text-xs text-muted">System-Prompt gecacht</div>}
                </td>
                <td className={cx(tdClass, "min-w-64 text-muted")}>
                  {t.decision
                    ? `${t.decision.status === "decided" ? "Entschieden" : "Vorläufig"}: ${t.decision.note}`
                    : "–"}
                  {task === "extract-facts" && (
                    <div className="mt-1" data-testid="extraction-approval">
                      {extractionApproval ? (
                        <Badge tone="ok" title={`am ${fmt.dateTime(extractionApproval.activatedAt)} von ${extractionApproval.activatedBy}`}>
                          freigegeben
                        </Badge>
                      ) : (
                        <Badge tone="warn" title="Keine Aktivierung dieser Konfiguration auf der Qualitätsseite (Regression)">
                          ohne Freigabe
                        </Badge>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </>
  );
}

/** Read-only label/value pairs; `mono` for raw parameter strings. */
function Pairs({ rows, mono = false }: { rows: [string, string][]; mono?: boolean }) {
  return (
    <DescriptionList
      columns={1}
      items={rows.map(([label, value]) => ({
        label,
        value: mono ? <span className="font-mono text-xs leading-relaxed break-words">{value}</span> : value,
      }))}
    />
  );
}
