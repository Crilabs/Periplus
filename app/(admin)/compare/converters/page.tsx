import Link from "next/link";
import type { ConverterName } from "@/lib/adapters/fetch";
import { getArchive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import {
  CONVERTER_SAMPLE,
  converterSampleDetail,
  converterSummary,
  listConverterSamples,
  sampleRated,
  type OutputState,
  type SampleOutput,
} from "@/lib/domain/converter-comparison";
import { CONVERTERS } from "@/lib/domain/sources/crawl-rules";
import { requireAdmin } from "@/lib/security/require-admin";
import { ArchiveMarkdown } from "../../_components/archive-markdown";
import { Dialog } from "../../_components/dialog";
import { comparePageError } from "../../_components/labels";
import {
  Badge,
  Button,
  ButtonLink,
  cx,
  DescriptionList,
  EmptyState,
  fmt,
  inputClass,
  Meter,
  Mono,
  Notice,
  numClass,
  PageHeader,
  Panel,
  Table,
  tdClass,
  thClass,
  trClass,
  type Tone,
} from "../../_components/ui";
import { rateOutputAction, startComparisonAction } from "./actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CONVERTER_LABELS: Record<ConverterName, string> = { jina: "Jina", firecrawl: "Firecrawl", local: "Lokal" };

const param = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const percent = (v: number | null) => (v === null ? "–" : `${v.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`);
const seconds = (ms: number) => `${(ms / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} s`;

/** State of one converter's output of a sample page, as a badge. */
function outputState(o: OutputState | undefined): { label: string; tone: Tone } {
  if (!o) return { label: "offen", tone: "neutral" };
  if (o.error) return { label: "Fehler", tone: "danger" };
  return o.rating ? { label: "bewertet", tone: "ok" } : { label: "zu bewerten", tone: "warn" };
}

function RatingForm({ sampleId, output }: { sampleId: string; output: SampleOutput }) {
  const r = output.rating;
  const tables = r?.tablesKept === undefined || r.tablesKept === null ? "" : r.tablesKept ? "yes" : "no";
  return (
    <form
      action={rateOutputAction}
      className="space-y-2.5 rounded-md border border-line bg-sunken/50 p-3"
      aria-label={`Bewertung ${CONVERTER_LABELS[output.converter]}`}
    >
      <input type="hidden" name="sampleId" value={sampleId} />
      <input type="hidden" name="converter" value={output.converter} />
      <label className="flex items-center gap-2" title="Der eigentliche Text der Seite steht vollständig im Markdown.">
        <input type="checkbox" name="mainContent" defaultChecked={r?.mainContent ?? false} className="size-4 accent-accent" />
        Hauptinhalt vollständig
      </label>
      <label className="flex items-center gap-2" title="Navigation, Cookie-Hinweise, Fußzeilen und Werbung fehlen im Markdown.">
        <input type="checkbox" name="boilerplateRemoved" defaultChecked={r?.boilerplateRemoved ?? false} className="size-4 accent-accent" />
        Boilerplate entfernt
      </label>
      <label className="flex flex-col gap-1">
        <span>Tabellen</span>
        <select name="tablesKept" defaultValue={tables} className={cx(inputClass, "h-8")}>
          <option value="">Seite ohne Tabellen</option>
          <option value="yes">erhalten</option>
          <option value="no">verloren oder zerstört</option>
        </select>
      </label>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button type="submit" variant="primary" size="sm">
          Speichern
        </Button>
        {output.ratedBy && <p className="text-xs text-muted">Bewertet von {output.ratedBy}</p>}
      </div>
    </form>
  );
}

export default async function Page({ searchParams }: PageProps<"/compare/converters">) {
  await requireAdmin();
  const sp = await searchParams;
  const sampleParam = param(sp.sample);
  const error = comparePageError(sp.error);
  const db = getDb();
  const [summary, samples] = await Promise.all([converterSummary(db), listConverterSamples(db)]);
  const detail = sampleParam && UUID.test(sampleParam) ? await converterSampleDetail(db, getArchive(), sampleParam) : null;
  const rated = samples.filter(sampleRated).length;
  const { fetch } = getConfig();
  const exceptions = Object.entries(fetch.converterBySource);
  const nextOpen = samples.find((s) => !sampleRated(s) && s.id !== detail?.id);
  const decided = fetch.decision.status === "decided";

  return (
    <>
      <PageHeader
        title="Konverter-Vergleich"
        description={
          <>
            Welcher Konverter macht aus archivierten HTML-Seiten das beste Markdown? Eine Stichprobe von{" "}
            {CONVERTER_SAMPLE.pages} Seiten ({CONVERTER_SAMPLE.perSource} aus jeder der {CONVERTER_SAMPLE.sources} größten
            freigegebenen Quellen) wird mit Jina, Firecrawl und dem lokalen Konverter umgewandelt und je Seite von Hand
            bewertet. Bewertungen, Kosten und Laufzeit führen zur Entscheidung in <code>config/fetch.json</code>.
          </>
        }
        meta={
          <>
            <Badge tone={decided ? "ok" : "warn"}>{decided ? "Entschieden" : "Vorläufig"}</Badge>
            <span>
              Standard <Mono>{fetch.defaultConverter}</Mono>
            </span>
          </>
        }
        actions={
          <Dialog
            trigger="Vergleich starten …"
            triggerVariant="primary"
            title="Vergleich starten"
            description="Startet einen Lauf, der die Stichprobe ergänzt und fehlende Umwandlungen nachholt."
          >
            <div className="space-y-4">
              <ul className="list-disc space-y-1.5 pl-5 leading-relaxed text-muted">
                <li>
                  Füllt die Stichprobe bis auf {CONVERTER_SAMPLE.pages} Seiten auf: je {CONVERTER_SAMPLE.perSource} HTML-Seiten
                  aus den {CONVERTER_SAMPLE.sources} freigegebenen Quellen mit den meisten Dokumenten. Vorhandene Seiten und
                  Bewertungen bleiben.
                </li>
                <li>
                  Wandelt jede Seite mit jedem Konverter um, von dem noch kein erfolgreiches Ergebnis vorliegt; fehlgeschlagene
                  Umwandlungen werden also erneut versucht.
                </li>
                <li>Jina und Firecrawl sind externe Dienste und kosten je Seite Geld; die Kosten erscheinen in der Zusammenfassung.</li>
                <li>Abgelehnt, solange noch ein Vergleichslauf aktiv ist oder alle Seiten schon von allen Konvertern umgewandelt sind.</li>
              </ul>
              <form action={startComparisonAction} className="flex justify-end">
                <Button type="submit" variant="primary">
                  Vergleich starten
                </Button>
              </form>
            </div>
          </Dialog>
        }
      />

      <div className="space-y-6">
        {error && <Notice tone="danger">Nicht ausgeführt: {error}</Notice>}

        <div className="grid gap-6 lg:grid-cols-3">
          <Panel title="Fortschritt" description="Eine Seite gilt als bewertet, wenn jede erfolgreiche Umwandlung bewertet ist.">
            <p className="text-sm">
              <strong className="text-2xl font-semibold tracking-tight tabular-nums">
                {rated} von {CONVERTER_SAMPLE.pages}
              </strong>{" "}
              bewertet
            </p>
            <div className="mt-3">
              <Meter ratio={rated / CONVERTER_SAMPLE.pages} label="Bewertete Seiten" />
            </div>
            <p className="mt-2 text-xs text-muted">{fmt.int(samples.length)} Seiten in der Stichprobe</p>
            {nextOpen && !detail && (
              <ButtonLink href={`/compare/converters?sample=${nextOpen.id}`} size="sm" variant="primary" className="mt-3">
                Nächste offene Seite bewerten
              </ButtonLink>
            )}
          </Panel>
          <Panel
            title="Aktuelle Entscheidung"
            description="Steht in config/fetch.json und gilt für alle Abrufe; Ausnahmen gelten je Quelle."
            className="lg:col-span-2"
          >
            <DescriptionList
              items={[
                { label: "Standard-Konverter", value: <Mono>{fetch.defaultConverter}</Mono> },
                {
                  label: "Ausnahmen je Quelle",
                  value: exceptions.length > 0 ? exceptions.map(([d, c]) => `${d} → ${c}`).join(", ") : "keine",
                },
                { label: "Notiz", value: fetch.decision.note },
              ]}
            />
          </Panel>
        </div>

        {detail && (
          <section aria-label="Seitenansicht">
            <Panel
              title={
                <span className="break-all">
                  {detail.domain}:{" "}
                  <a
                    href={detail.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="font-normal text-accent underline-offset-2 hover:underline"
                  >
                    {detail.url}
                  </a>
                </span>
              }
              description="Die drei Umwandlungen derselben Seite nebeneinander. Jede Spalte einzeln bewerten und speichern."
              actions={
                <>
                  <ButtonLink href="/compare/converters" size="sm" variant="ghost">
                    Schließen
                  </ButtonLink>
                  {nextOpen && (
                    <ButtonLink href={`/compare/converters?sample=${nextOpen.id}`} size="sm" variant="primary">
                      Nächste offene Seite →
                    </ButtonLink>
                  )}
                </>
              }
            >
              <div className="grid gap-4 lg:grid-cols-3">
                {CONVERTERS.map((name) => {
                  const output = detail.outputs.find((o) => o.converter === name);
                  const state = outputState(output);
                  return (
                    <div key={name} id={name} className="flex min-w-0 scroll-mt-6 flex-col gap-3 rounded-lg border border-line p-3">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-semibold">{CONVERTER_LABELS[name]}</h3>
                        <Badge tone={state.tone}>{state.label}</Badge>
                      </div>
                      {!output ? (
                        <p className="text-sm text-muted">Noch nicht umgewandelt. „Vergleich starten“ holt das nach.</p>
                      ) : output.error ? (
                        <Notice tone="danger" className="break-words">
                          Fehler: {output.error}
                        </Notice>
                      ) : (
                        <>
                          <p className="text-xs text-muted tabular-nums">
                            {fmt.int(output.chars)} Zeichen · {seconds(output.durationMs)} · {fmt.eur(output.costEur, 4)}
                          </p>
                          <RatingForm sampleId={detail.id} output={output} />
                          <div className="max-h-[70vh] overflow-auto rounded-md border border-line bg-canvas p-3 text-sm">
                            {output.markdown === null ? (
                              <p className="text-muted">Markdown fehlt im Archiv.</p>
                            ) : (
                              <ArchiveMarkdown markdown={output.markdown} />
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </Panel>
          </section>
        )}

        <Panel
          title="Zusammenfassung"
          description="Anteile beziehen sich auf die bewerteten Seiten (Tabellen nur auf bewertete Seiten mit Tabellen); Kosten, Laufzeit und Zeichen sind Mittelwerte der erfolgreichen Umwandlungen."
          flush
        >
          <Table>
            <thead>
              <tr>
                <th className={thClass}>Konverter</th>
                <th className={cx(thClass, "text-right")}>Seiten</th>
                <th className={cx(thClass, "text-right")}>Fehler</th>
                <th className={cx(thClass, "text-right")}>Bewertet</th>
                <th className={cx(thClass, "text-right")} title="Anteil der bewerteten Seiten mit vollständigem Hauptinhalt">
                  Hauptinhalt
                </th>
                <th className={cx(thClass, "text-right")}>Boilerplate entfernt</th>
                <th className={cx(thClass, "text-right")}>Tabellen erhalten</th>
                <th className={cx(thClass, "text-right")}>Kosten je Seite</th>
                <th className={cx(thClass, "text-right")}>Laufzeit je Seite</th>
                <th className={cx(thClass, "text-right")}>Zeichen je Seite</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.converter} className={trClass}>
                  <td className={cx(tdClass, "font-medium")}>{CONVERTER_LABELS[s.converter]}</td>
                  <td className={cx(tdClass, numClass)}>{s.pages}</td>
                  <td className={cx(tdClass, numClass, s.errors > 0 && "text-danger")}>{s.errors}</td>
                  <td className={cx(tdClass, numClass)}>{s.rated}</td>
                  <td className={cx(tdClass, numClass)}>{percent(s.mainContentPct)}</td>
                  <td className={cx(tdClass, numClass)}>{percent(s.boilerplatePct)}</td>
                  <td className={cx(tdClass, numClass)}>{percent(s.tablesPct)}</td>
                  <td className={cx(tdClass, numClass)}>{fmt.eur(s.avgCostEur, 4)}</td>
                  <td className={cx(tdClass, numClass)}>{seconds(s.avgDurationMs)}</td>
                  <td className={cx(tdClass, numClass)}>{fmt.int(s.avgChars)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>

        <Panel title="Seiten" description="Eine Seite öffnen, um die drei Umwandlungen nebeneinander zu sehen und zu bewerten." flush>
          {samples.length === 0 ? (
            <EmptyState title="Noch keine Stichprobe">
              „Vergleich starten“ wählt {CONVERTER_SAMPLE.pages} Seiten der größten freigegebenen Quellen und wandelt sie um.
            </EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={thClass}>Seite</th>
                  <th className={thClass}>Quelle</th>
                  {CONVERTERS.map((c) => (
                    <th key={c} className={thClass}>
                      {CONVERTER_LABELS[c]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {samples.map((s) => (
                  <tr key={s.id} className={cx(trClass, s.id === detail?.id && "bg-accent-soft")}>
                    <td className={cx(tdClass, "max-w-md")}>
                      <Link
                        href={`/compare/converters?sample=${s.id}`}
                        title={s.url}
                        aria-current={s.id === detail?.id ? "true" : undefined}
                        className="block truncate text-accent underline-offset-2 hover:underline"
                      >
                        {s.url}
                      </Link>
                    </td>
                    <td className={cx(tdClass, "whitespace-nowrap text-muted")}>{s.domain}</td>
                    {CONVERTERS.map((c) => {
                      const state = outputState(s.outputs[c]);
                      return (
                        <td key={c} className={tdClass}>
                          <Badge tone={state.tone}>{state.label}</Badge>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
