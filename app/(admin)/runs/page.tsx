import type { Metadata } from "next";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { listRuns } from "@/lib/domain/runs";
import { listSubdivisionOptions } from "@/lib/domain/subdivisions/store";
import { requireAdmin } from "@/lib/security/require-admin";
import { AutoRefresh } from "../_components/auto-refresh";
import { Dialog } from "../_components/dialog";
import { runScopeError } from "../_components/labels";
import { RunsTable } from "../_components/runs-table";
import { SubdivisionOptions } from "../_components/subdivision-options";
import { Button, cx, inputClass, Notice, PageHeader, Panel } from "../_components/ui";
import {
  startDatasetImportAction,
  startGazetteerAction,
  startGeometryAction,
  startPingRun,
  startReprocessAction,
  startRevisitAction,
  startSeedAction,
  startTextRunAction,
} from "./actions";

export const metadata: Metadata = { title: "Läufe" };

type ScopedRun = {
  id: string;
  name: string;
  description: string;
  action: (input: FormData) => Promise<void>;
  button: string;
  /** What the run is scoped by: a subdivision (Landesteil) or, until plan 14a task 9, a configured area (Revier). */
  scope: "subdivision" | "area";
};

/** The runs of the start dialog, in pipeline order; each says what it does and what it needs first. */
const RUNS: ScopedRun[] = [
  {
    id: "gazetteer",
    name: "Gazetteer",
    description:
      "Legt die Kacheln des Landesteils an und sammelt Inseln, Buchten, Häfen, Orte und Highlights aus OSM, Wikidata und GeoNames. Erster Lauf für einen neuen Landesteil.",
    action: startGazetteerAction,
    button: "Gazetteer aufbauen",
    scope: "subdivision",
  },
  {
    id: "seed",
    name: "Seed",
    description:
      "Legt aus Buchten, Häfen und Marinas der Küstenkacheln Ortskandidaten an. Braucht einen Gazetteer-Lauf für den Landesteil.",
    action: startSeedAction,
    button: "Seed für Landesteil",
    scope: "subdivision",
  },
  {
    id: "datasets",
    name: "Datensätze",
    description:
      "Lädt Tiefendaten, Meeresboden, Sperrgebiete, Schiffsdichte, Straßen und Wikipedia-Verweise für den Landesteil. Braucht die Küstenkacheln aus dem Gazetteer-Lauf.",
    action: startDatasetImportAction,
    button: "Datensätze laden",
    scope: "subdivision",
  },
  {
    id: "geometry",
    name: "Geometrie",
    description:
      "Sucht zuerst unbenannte Buchten an der Küste (neue Ortskandidaten fürs Review), berechnet dann je Ort Fetch, Schutz je Sektor, Öffnung zur See und Schwell und aktualisiert danach Profil und Zusammenfassung. Braucht Tiefendaten und Landpolygone (Datensätze laden).",
    action: startGeometryAction,
    button: "Geometrie für Landesteil",
    scope: "subdivision",
  },
  {
    id: "texts",
    name: "Texte",
    description:
      "Wertet die Texte aus, die Objekte des Reviers erwähnen, dazu die noch offenen Versionen ihrer Quellen: Erwähnungen zuordnen, Facts mit Zitat extrahieren, Belegtreue prüfen, konsolidieren. Nach neuen oder geänderten Quellen.",
    action: startTextRunAction,
    button: "Texte auswerten für Revier",
    scope: "area",
  },
  {
    id: "reprocess",
    name: "Reprozessieren",
    description:
      "Extrahiert jede Erwähnung im Revier erneut mit dem aktuell konfigurierten Modell, Prompt und Fact-Schema in einen neuen Extraktionslauf; die alten Facts bleiben. Nach einer Änderung an Modell, Prompt oder Schema.",
    action: startReprocessAction,
    button: "Reprozessieren für Revier (Stufen 6–7)",
    scope: "area",
  },
  {
    id: "revisit",
    name: "Revisit",
    description:
      "Ruft alle freigegebenen Quellen erneut ab und wertet aus, was sich geändert hat: neue Fassungen, verschwundene Seiten, Facts, Konsolidierung und Änderungsereignisse des Reviers. Der zweite Durchgang nach dem ersten vollen Lauf. Solange er läuft, startet kein Crawl dieser Quellen.",
    action: startRevisitAction,
    button: "Revisit für Revier",
    scope: "area",
  },
];

export default async function Page({ searchParams }: PageProps<"/runs">) {
  await requireAdmin();
  const error = runScopeError((await searchParams).error);
  const runs = await listRuns(getDb(), { limit: 50 });
  const areas = getConfig().areas.map((a) => ({ key: a.key, name: a.names.de ?? a.key }));
  const areaOptions = areas.map((a) => (
    <option key={a.key} value={a.key}>
      {a.name}
    </option>
  ));
  const subdivisionOptions = <SubdivisionOptions options={await listSubdivisionOptions(getDb())} />;
  return (
    <>
      <AutoRefresh intervalMs={5000} />
      <PageHeader
        title="Läufe"
        description="Jede Verarbeitung ist ein Lauf aus Stufen. Hier lassen sich Läufe für einen Landesteil starten und die letzten 50 verfolgen; die Seite aktualisiert sich alle fünf Sekunden."
        actions={
          <>
            <form
              action={startPingRun}
              className="flex items-center gap-2"
              title="Testlauf ohne externe Dienste: prüft, ob der Worker Jobs annimmt und abschließt."
            >
              <label htmlFor="count" className="text-xs text-muted">
                Anzahl Pings
              </label>
              <input
                id="count"
                name="count"
                type="number"
                min={1}
                max={50}
                defaultValue={3}
                required
                className={cx(inputClass, "w-16")}
              />
              <Button type="submit">Ping-Lauf starten</Button>
            </form>
            <Dialog
              trigger="Lauf starten …"
              triggerVariant="primary"
              title="Lauf starten"
              description="Die Läufe bauen in dieser Reihenfolge aufeinander auf. Fehlt eine Voraussetzung, startet der Lauf nicht und die Seite sagt, was fehlt."
              wide
            >
              <ol className="divide-y divide-line">
                {RUNS.map((run, i) => (
                  <li key={run.id} className="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[1fr_auto] md:items-end">
                    <div className="min-w-0">
                      <h3 className="font-medium">
                        <span className="mr-1.5 text-muted tabular-nums">{i + 1}.</span>
                        {run.name}
                      </h3>
                      <p className="mt-0.5 leading-relaxed text-muted text-pretty">{run.description}</p>
                    </div>
                    <form action={run.action} className="flex flex-wrap items-end gap-2">
                      <label htmlFor={`${run.id}-scope`} className="sr-only">
                        {run.scope === "subdivision" ? "Landesteil" : "Revier"}
                      </label>
                      <select
                        id={`${run.id}-scope`}
                        name={run.scope === "subdivision" ? "subdivisionKey" : "areaKey"}
                        required
                        className={cx(inputClass, "min-w-40")}
                      >
                        {run.scope === "subdivision" ? subdivisionOptions : areaOptions}
                      </select>
                      <Button type="submit" variant="primary">
                        {run.button}
                      </Button>
                    </form>
                  </li>
                ))}
              </ol>
            </Dialog>
          </>
        }
      />
      {error && (
        <Notice tone="danger" title="Lauf nicht gestartet" className="mb-6">
          {error}.
        </Notice>
      )}
      <Panel title="Letzte Läufe" description="Die 50 neuesten Läufe, neueste zuerst. Ein Klick auf einen Lauf zeigt Stufen, Fehler und Kosten." flush>
        <RunsTable
          runs={runs}
          empty="Läufe entstehen über „Lauf starten …“ oder wenn eine Prüfung einen Folgelauf anstößt."
        />
      </Panel>
    </>
  );
}
