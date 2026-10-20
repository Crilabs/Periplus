import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { changeRateEnum, DOC_TYPES } from "@/lib/db/schema";
import { documentOfOtherSource, SOURCES_PAGE_SIZE, sourceDetail } from "@/lib/domain/sources-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { AutoRefresh } from "../../_components/auto-refresh";
import { CrawlRulesFields } from "../../_components/crawl-rules-fields";
import { Dialog } from "../../_components/dialog";
import {
  CHANGE_RATE_LABELS,
  CONVERTER_LABELS,
  DOC_TYPE_LABELS,
  DOCUMENT_STATUS_LABELS,
  FRONTIER_STATUS_LABELS,
  RENDER_MODE_LABELS,
  RUN_KIND_LABELS,
  SCOPE_TYPE_LABELS,
  SOURCE_ORIGIN_LABELS,
  SOURCE_STATUS_LABELS,
  sourcePageError,
} from "../../_components/labels";
import { RunStatusBadge } from "../../_components/runs-table";
import {
  Badge,
  Button,
  ButtonLink,
  DescriptionList,
  EmptyState,
  Field,
  fmt,
  inputClass,
  Mono,
  Notice,
  numClass,
  PageHeader,
  Pagination,
  Panel,
  Stat,
  Table,
  tdClass,
  TextLink,
  thClass,
  trClass,
} from "../../_components/ui";
import { pendingTextRunAction } from "../actions";
import { SOURCE_STATUS_TONES } from "../tones";
import {
  crawlAction,
  endSourceAction,
  pauseSourceAction,
  resumeSourceAction,
  saveSourceAction,
  testCrawlAction,
  uploadPdfAction,
} from "./actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SETTINGS_FIELDS = new Set(["name", "type", "weight", "changeRate"]);

const param = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const eur = (n: number) => fmt.eur(n, 4);
const weight = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });

export default async function Page({ params, searchParams }: PageProps<"/sources/[id]">) {
  await requireAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const docPage = Math.max(1, Number.parseInt(param(sp.docPage) ?? "1", 10) || 1);
  const db = getDb();
  const detail = await sourceDetail(db, id, { docPage });
  if (!detail) notFound();
  const { source, frontier, costs } = detail;
  const archivedParam = param(sp.archived);
  const archivedElsewhere = archivedParam && UUID.test(archivedParam) ? await documentOfOtherSource(db, archivedParam, id) : null;
  // An ended source is shown read-only: no crawl, status change, upload or saving.
  const ended = source.validTo !== null;
  const uploadable = !ended && source.status !== "rejected";
  const error = sourcePageError(sp.error);
  const endedObjects = param(sp.ended);
  const endedRun = param(sp.run);
  const invalid = (param(sp.invalid) ?? "").split(",").filter((f) => f !== "");
  const mark = (field: string) =>
    invalid.includes(field) ? (
      <span role="alert" className="text-xs font-medium text-danger">
        Ungültig
      </span>
    ) : null;
  const docPages = Math.max(1, Math.ceil(detail.documentTotal / SOURCES_PAGE_SIZE));
  const active = detail.runs.some((r) => r.status === "queued" || r.status === "running");
  const hidden = <input type="hidden" name="sourceId" value={source.id} />;
  const rules = source.crawlRules;
  const now = new Date();

  const settingsForm = (
    <form action={saveSourceAction} className="grid gap-5">
      {hidden}
      <fieldset disabled={ended} className="contents">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={<>Name {mark("name")}</>}>
            <input name="name" required maxLength={200} defaultValue={source.name} className={inputClass} />
          </Field>
          <Field label={<>Typ {mark("type")}</>} hint="Art der Texte dieser Quelle.">
            <select name="type" defaultValue={source.type} className={inputClass}>
              {DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOC_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={<>Gewicht {mark("weight")}</>} hint="0 bis 1: wie stark Facts dieser Quelle in der Konsolidierung zählen.">
            <input
              type="number"
              name="weight"
              required
              min={0}
              max={1}
              step="any"
              defaultValue={source.weight}
              className={inputClass}
            />
          </Field>
          <Field label={<>Änderungsrate {mark("changeRate")}</>} hint="Wie oft sich die Inhalte der Quelle erfahrungsgemäß ändern.">
            <select name="changeRate" defaultValue={source.changeRate} className={inputClass}>
              {changeRateEnum.enumValues.map((c) => (
                <option key={c} value={c}>
                  {CHANGE_RATE_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <CrawlRulesFields defaults={rules} invalid={invalid.filter((f) => !SETTINGS_FIELDS.has(f))} />
      </fieldset>
      {!ended && (
        <div className="flex justify-end">
          <Button variant="primary">Speichern</Button>
        </div>
      )}
    </form>
  );

  return (
    <>
      {active && <AutoRefresh intervalMs={5000} />}
      <PageHeader
        title={source.name}
        back={{ href: "/sources", label: "Quellen" }}
        meta={
          <>
            <Badge tone={SOURCE_STATUS_TONES[source.status]}>{SOURCE_STATUS_LABELS[source.status]}</Badge>
            {source.validTo && <Badge tone="danger">{`beendet am ${source.validTo}`}</Badge>}
            <span>{source.domain}</span>
            {source.statusReason && <span>· {source.statusReason}</span>}
          </>
        }
        actions={
          <>
            <form action={pendingTextRunAction}>
              <Button
                variant="ghost"
                title="Alle Quellen: jede aktuelle Version, die der Abgleich noch nicht gesehen hat"
              >
                Neue Texte auswerten
              </Button>
            </form>
            {uploadable && (
              <Dialog
                trigger="PDF hochladen …"
                title="PDF hochladen"
                description="Archiviert eine PDF-Datei als Dokument dieser Quelle und startet ihre Verarbeitung. Höchstens 100 MB."
              >
                <form action={uploadPdfAction} className="grid gap-4">
                  {hidden}
                  <Field label="PDF hochladen (höchstens 100 MB)">
                    <input
                      type="file"
                      name="file"
                      accept="application/pdf,.pdf"
                      required
                      className="text-sm file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-ink"
                    />
                  </Field>
                  <div className="flex justify-end">
                    <Button variant="primary">Hochladen und archivieren</Button>
                  </div>
                </form>
              </Dialog>
            )}
            {!ended && source.status === "approved" && (
              <>
                <form action={pauseSourceAction}>
                  {hidden}
                  <Button>Pausieren</Button>
                </form>
                <form action={testCrawlAction}>
                  {hidden}
                  <Button title="Crawlt höchstens 10 Seiten, um die Crawl-Regeln zu prüfen">Testcrawl 10 Seiten</Button>
                </form>
                <form action={crawlAction}>
                  {hidden}
                  <Button variant="primary">Crawlen</Button>
                </form>
              </>
            )}
            {!ended && source.status === "paused" && (
              <form action={resumeSourceAction}>
                {hidden}
                <Button variant="primary">Fortsetzen</Button>
              </form>
            )}
            {!ended && (source.status === "approved" || source.status === "paused") && (
              <Dialog
                trigger="Quelle beenden …"
                triggerVariant="danger"
                title="Quelle beenden"
                description="Beendet die Quelle endgültig: Sie wird nicht mehr gecrawlt, und ihre Facts zählen in keinem Profil mehr. Danach werden die Objekte mit Facts aus ihr neu konsolidiert. Lässt sich nicht rückgängig machen."
              >
                <form action={endSourceAction} className="flex justify-end">
                  {hidden}
                  <Button variant="danger">Quelle beenden</Button>
                </form>
              </Dialog>
            )}
          </>
        }
      />

      <div className="space-y-6">
        {(error || invalid.length > 0 || archivedElsewhere || param(sp.saved) === "1" || endedObjects !== undefined) && (
          <div className="space-y-3">
            {endedObjects !== undefined && (
              <Notice
                tone={param(sp.endedNoRun) === "1" ? "warn" : "ok"}
                title="Quelle beendet"
                actions={
                  endedRun &&
                  UUID.test(endedRun) && (
                    <ButtonLink href={`/runs/${endedRun}`} size="sm">
                      Lauf ansehen
                    </ButtonLink>
                  )
                }
              >
                {endedObjects === "0"
                  ? "Ihre Facts zählen nicht mehr. Kein Objekt hatte Facts aus ihr."
                  : param(sp.endedNoRun) === "1"
                    ? `Ihre Facts zählen nicht mehr. Die Neuberechnung von ${endedObjects} Objekten ist nicht gestartet: „Profil neu berechnen“ auf den Orten.`
                    : `Ihre Facts zählen nicht mehr. ${endedObjects} Objekte werden neu konsolidiert.`}
              </Notice>
            )}
            {error && (
              <Notice tone="danger" title="Nicht ausgeführt">
                {error}
              </Notice>
            )}
            {invalid.length > 0 && (
              <Notice tone="danger" title="Nicht gespeichert">
                Ungültige Felder sind unten markiert. Korrigieren und erneut speichern.
              </Notice>
            )}
            {archivedElsewhere && (
              <Notice tone="warn">
                <Link href={`/documents/${archivedElsewhere.documentId}`} className="text-accent hover:underline">
                  Dieses Dokument
                </Link>{" "}
                ist bereits bei Quelle {archivedElsewhere.sourceDomain} archiviert.
              </Notice>
            )}
            {param(sp.saved) === "1" && <Notice tone="ok">Gespeichert.</Notice>}
          </div>
        )}

        {invalid.length > 0 && (
          <Panel title="Einstellungen und Crawl-Regeln" description="Nicht gespeichert: bitte die markierten Felder korrigieren.">
            {settingsForm}
          </Panel>
        )}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Dokumente" value={fmt.int(detail.documentTotal)} hint="Archivierte Seiten und Dateien" />
          <Stat
            label="Frontier offen"
            value={fmt.int(frontier.queued)}
            tone={frontier.failed > 0 ? "warn" : "neutral"}
            hint={`${FRONTIER_STATUS_LABELS.fetched} ${fmt.int(frontier.fetched)} · ${FRONTIER_STATUS_LABELS.skipped} ${fmt.int(frontier.skipped)} · ${FRONTIER_STATUS_LABELS.failed} ${fmt.int(frontier.failed)}`}
          />
          <Stat label="Gewicht" value={weight(source.weight)} hint="Zählt in der Konsolidierung (0 bis 1)" />
          <Stat label="Kosten gesamt" value={eur(costs.totalEur)} hint="Externe Aufrufe für diese Quelle" />
        </div>

        <div className="grid gap-6 xl:grid-cols-3">
          <div className="min-w-0 xl:col-span-2">
            <Panel
              title={`Dokumente (${fmt.int(detail.documentTotal)})`}
              description="Die Seiten und Dateien dieser Quelle im Archiv. Ein Dokument öffnen, um Text und Versionen zu sehen."
              flush
            >
              {detail.documents.length === 0 ? (
                <EmptyState title="Noch keine Dokumente">
                  {source.status === "approved"
                    ? "Dokumente entstehen beim Crawlen oder durch einen PDF-Upload."
                    : "Dokumente entstehen beim Crawlen einer freigegebenen Quelle oder durch einen PDF-Upload."}
                </EmptyState>
              ) : (
                <>
                  <Table>
                    <thead>
                      <tr>
                        <th className={thClass}>URL</th>
                        <th className={thClass}>Status</th>
                        <th className={`${thClass} text-right`}>Versionen</th>
                        <th className={thClass}>Zuletzt geprüft</th>
                        <th className={thClass}>Sprache</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.documents.map((d) => (
                        <tr key={d.id} className={trClass}>
                          <td className={`${tdClass} max-w-md`}>
                            <Link
                              href={`/documents/${d.id}`}
                              title={d.url}
                              className="block truncate text-accent hover:underline"
                            >
                              {d.url.replace(/^https?:\/\//, "")}
                            </Link>
                          </td>
                          <td className={tdClass}>
                            <Badge tone={d.status === "gone" ? "warn" : "neutral"}>{DOCUMENT_STATUS_LABELS[d.status]}</Badge>
                          </td>
                          <td className={`${tdClass} ${numClass}`}>{fmt.int(d.versions)}</td>
                          <td className={`${tdClass} whitespace-nowrap`} title={fmt.dateTime(d.lastCheckedAt)}>
                            {fmt.ago(d.lastCheckedAt, now)}
                          </td>
                          <td className={tdClass}>{d.language ?? "–"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  {docPages > 1 && (
                    <div className="border-t border-line">
                      <Pagination
                        page={docPage}
                        pages={docPages}
                        total={detail.documentTotal}
                        noun="Dokumente"
                        href={(p) => `/sources/${source.id}?docPage=${p}`}
                      />
                    </div>
                  )}
                </>
              )}
            </Panel>
          </div>

          <div className="min-w-0 space-y-6">
            <Panel title="Eigenschaften">
              <DescriptionList
                columns={1}
                items={[
                  { label: "Domain", value: source.domain },
                  { label: "Typ", value: DOC_TYPE_LABELS[source.type] },
                  { label: "Änderungsrate", value: CHANGE_RATE_LABELS[source.changeRate] },
                  { label: "Herkunft", value: SOURCE_ORIGIN_LABELS[source.origin] },
                  { label: "Sprachen", value: source.languages.join(", ") || "–" },
                  { label: "Angelegt", value: fmt.dateTime(source.createdAt) },
                  costs.byService.length > 0 && {
                    label: "Kosten je Dienst",
                    value: (
                      <ul className="space-y-0.5">
                        {costs.byService.map((c) => (
                          <li key={c.service} className="flex justify-between gap-3">
                            <Mono>{c.service}</Mono>
                            <span className="tabular-nums">
                              {fmt.int(c.calls)} Aufrufe · {eur(c.costEur)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ),
                  },
                ]}
              />
            </Panel>

            <Panel
              title="Crawl-Regeln"
              description="Wo der Crawler anfängt, welchen Pfaden er folgt und wie schnell er abruft."
              actions={
                invalid.length === 0 && (
                  <Dialog
                    trigger={ended ? "Crawl-Regeln ansehen" : "Crawl-Regeln bearbeiten"}
                    triggerSize="sm"
                    title="Einstellungen und Crawl-Regeln"
                    description={
                      ended
                        ? "Die Quelle ist beendet; ihre Einstellungen lassen sich nicht mehr ändern."
                        : "Name, Typ, Gewicht, Änderungsrate und Crawl-Regeln."
                    }
                    wide
                  >
                    {settingsForm}
                  </Dialog>
                )
              }
            >
              <DescriptionList
                columns={2}
                items={[
                  {
                    label: "Start-URLs",
                    value: rules.startUrls.length > 0 ? fmt.int(rules.startUrls.length) : "keine",
                  },
                  { label: "Erlaubte / gesperrte Pfade", value: `${rules.allow.length || "alle"} / ${rules.deny.length}` },
                  { label: "Tiefe / Seiten", value: `${rules.maxDepth} / ${fmt.int(rules.maxPages)}` },
                  { label: "Abrufe pro Minute", value: weight(rules.ratePerMinute) },
                  { label: "Rendern", value: RENDER_MODE_LABELS[rules.render] },
                  { label: "Konverter", value: CONVERTER_LABELS[rules.converter] },
                  { label: "PDFs", value: rules.pdf ? "werden abgerufen" : "nein" },
                ]}
              />
            </Panel>

            <Panel title="Letzte Läufe" description="Die zehn neuesten Läufe, die diese Quelle betreffen." flush>
              {detail.runs.length === 0 ? (
                <EmptyState title="Noch keine Läufe">Crawlen oder ein Testcrawl startet den ersten Lauf.</EmptyState>
              ) : (
                <ul className="divide-y divide-line">
                  {detail.runs.map((r) => (
                    <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <Link href={`/runs/${r.id}`} className="font-medium text-accent hover:underline">
                          {RUN_KIND_LABELS[r.kind]}
                        </Link>{" "}
                        <Mono title={r.id}>{r.id.slice(0, 8)}</Mono>
                        <div className="truncate text-xs text-muted" title={r.stages.join(", ")}>
                          {SCOPE_TYPE_LABELS[r.scopeType]}: {r.scopeId === source.id ? "diese Quelle" : r.scopeId}
                          {" · "}
                          <span title={fmt.dateTime(r.createdAt)}>{fmt.ago(r.createdAt, now)}</span>
                        </div>
                      </div>
                      <RunStatusBadge status={r.status} />
                    </li>
                  ))}
                </ul>
              )}
              {detail.runs.length > 0 && (
                <div className="border-t border-line px-4 py-2.5 text-sm">
                  <TextLink href="/runs">Alle Läufe</TextLink>
                </div>
              )}
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
