import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getArchive } from "@/lib/adapters/s3";
import { getDb } from "@/lib/db/client";
import { documentDetail, versionContent, versionDiff, type VersionChunk } from "@/lib/domain/document-view";
import { versionAnnotations, type ChunkAnnotations } from "@/lib/domain/text-annotations";
import { requireAdmin } from "@/lib/security/require-admin";
import { AnnotatedText, AnnotationLegend } from "../../_components/annotated-text";
import { ArchiveMarkdown } from "../../_components/archive-markdown";
import { Dialog } from "../../_components/dialog";
import { DiffView } from "../../_components/diff-view";
import {
  DOC_TYPE_LABELS,
  DOCUMENT_STATUS_LABELS,
  factAttributeLabel,
  formatFactValue,
  MATCH_KIND_LABELS,
  OBSERVED_AT_BASIS_LABELS,
} from "../../_components/labels";
import {
  Badge,
  buttonClass,
  cx,
  DescriptionList,
  EmptyState,
  fmt,
  Mono,
  Notice,
  numClass,
  PageHeader,
  Panel,
  TabNav,
  Table,
  tdClass,
  TextLink,
  thClass,
  trClass,
} from "../../_components/ui";

export const metadata: Metadata = { title: "Dokument" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const param = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const isWebUrl = (url: string) => /^https?:\/\//i.test(url);
const share = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });

/** Tabs of the document page (`?tab=`). */
const TABS = { content: "Inhalt", annotations: "Erwähnungen und Zitate" } as const;
type Tab = keyof typeof TABS;

export default async function Page({ params, searchParams }: PageProps<"/documents/[id]">) {
  await requireAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = getDb();
  const detail = await documentDetail(db, id);
  if (!detail) notFound();
  const { document, source, versions } = detail;
  const sp = await searchParams;
  const known = (v: string | undefined) => (v && versions.some((x) => x.id === v) ? v : undefined);
  const selectedId = known(param(sp.v)) ?? document.currentVersionId ?? versions[0]?.id;
  const compareId = known(param(sp.diff));
  const tab: Tab = param(sp.tab) === "annotations" ? "annotations" : "content";
  const archive = getArchive();
  const [content, diff, annotations] = await Promise.all([
    selectedId && tab === "content" ? versionContent(db, archive, id, selectedId) : null,
    selectedId && tab === "content" && compareId && compareId !== selectedId ? versionDiff(db, archive, id, compareId, selectedId) : null,
    selectedId && tab === "annotations" ? versionAnnotations(db, selectedId) : null,
  ]);
  const selected = versions.find((v) => v.id === selectedId);
  const versionHref = (v: string, compare?: string) =>
    `/documents/${id}?v=${v}${compare ? `&diff=${compare}` : ""}${tab === "annotations" ? "&tab=annotations" : ""}`;
  const tabHref = (t: Tab) => `/documents/${id}${selectedId ? `?v=${selectedId}` : ""}${t === "annotations" ? `${selectedId ? "&" : "?"}tab=annotations` : ""}`;
  const compared = compareId ? versions.find((v) => v.id === compareId) : undefined;
  const now = new Date();

  return (
    <>
      <PageHeader
        title={<span className="break-all">{document.url}</span>}
        back={{ href: `/sources/${source.id}`, label: source.domain }}
        meta={
          <>
            <Badge tone={document.status === "gone" ? "warn" : "neutral"}>{DOCUMENT_STATUS_LABELS[document.status]}</Badge>
            <span>{DOC_TYPE_LABELS[source.type]}</span>
            <span>
              · {versions.length} {versions.length === 1 ? "Version" : "Versionen"}
            </span>
          </>
        }
        actions={
          isWebUrl(document.url) ? (
            <a href={document.url} target="_blank" rel="noopener noreferrer nofollow" className={buttonClass("secondary", "sm")}>
              Original <span aria-hidden>↗</span>
            </a>
          ) : (
            <Badge>Hochgeladene Datei</Badge>
          )
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {document.status === "gone" && (
            <Notice tone="warn" title="Seite verschwunden">
              Die Seite ist verschwunden (zweimal 404/410); das Archiv bleibt erhalten.
            </Notice>
          )}

          {!selected && (
            <Panel>
              <EmptyState title="Noch keine Version archiviert">
                Eine Version entsteht, wenn ein Crawl der Quelle die Seite abruft.
              </EmptyState>
            </Panel>
          )}

          {selected && (
            <div>
              <TabNav
                items={(Object.keys(TABS) as Tab[]).map((t) => ({ href: tabHref(t), label: TABS[t], current: t === tab }))}
              />

              {tab === "content" && (
                <div className="space-y-6">
                  {diff && compared && (
                    <Panel
                      title={`Änderungen seit ${fmt.dateTime(compared.fetchedAt)}`}
                      description="Zeilenvergleich mit der gewählten Version; lange unveränderte Abschnitte sind gekürzt."
                      actions={
                        <TextLink href={versionHref(selected.id)} className="text-sm">
                          Vergleich schließen
                        </TextLink>
                      }
                    >
                      <DiffView lines={diff} />
                    </Panel>
                  )}

                  {!content && (
                    <Notice tone="danger" title="Inhalt fehlt">
                      Das Markdown dieser Version fehlt im Archiv.
                    </Notice>
                  )}
                  {content && (
                    <Panel
                      title="Inhalt"
                      description={`Text der Version vom ${fmt.dateTime(selected.fetchedAt)}, wie er archiviert und in Abschnitte zerlegt wurde.`}
                      actions={
                        <Dialog
                          trigger={`Abschnitte (${content.chunks.length})`}
                          triggerSize="sm"
                          title={`Abschnitte (${content.chunks.length})`}
                          description="Abschnitte, in die der Text für Abgleich und Extraktion zerlegt ist. Übernommene Abschnitte sind gegenüber der vorigen Version unverändert."
                          wide
                        >
                          <ChunkTable chunks={content.chunks} />
                        </Dialog>
                      }
                    >
                      <div className="px-1 py-2 sm:px-4">
                        <ArchiveMarkdown markdown={content.markdown} />
                      </div>
                    </Panel>
                  )}
                </div>
              )}

              {annotations && <Annotations chunks={annotations} />}
            </div>
          )}
        </div>

        <aside className="min-w-0 space-y-6">
          <Panel title="Dokument">
            <DescriptionList
              columns={1}
              items={[
                {
                  label: "Quelle",
                  value: (
                    <>
                      <TextLink href={`/sources/${source.id}`}>{source.name}</TextLink>
                      <div className="text-xs text-muted">
                        {source.domain} · Gewicht {share(source.weight)}
                      </div>
                    </>
                  ),
                },
                {
                  label: "Zuerst gesehen",
                  value: <span title={fmt.dateTime(document.firstSeenAt)}>{fmt.ago(document.firstSeenAt, now)}</span>,
                },
                {
                  label: "Zuletzt geprüft",
                  value: <span title={fmt.dateTime(document.lastCheckedAt)}>{fmt.ago(document.lastCheckedAt, now)}</span>,
                },
              ]}
            />
          </Panel>

          {selected && (
            <Panel title="Diese Version">
              <DescriptionList
                columns={1}
                items={[
                  { label: "Abgerufen", value: fmt.dateTime(selected.fetchedAt) },
                  {
                    label: "Beobachtet",
                    value: (
                      <>
                        {selected.observedAt}{" "}
                        <span className="text-xs text-muted">({OBSERVED_AT_BASIS_LABELS[selected.basis]})</span>
                      </>
                    ),
                    hint: "Beobachtungsdatum der Angaben und woher es stammt",
                  },
                  selected.publishedAt !== null && { label: "Veröffentlicht", value: selected.publishedAt },
                  {
                    label: "Konverter · Sprache",
                    value: `${selected.converter} · ${selected.language ?? "–"}`,
                  },
                  {
                    label: "Abschnitte",
                    value: `${fmt.int(selected.chunks)}, davon ${fmt.int(selected.carried)} übernommen`,
                  },
                  { label: "Hash", value: <Mono>{selected.hash8}</Mono> },
                  {
                    label: "Rohdatei",
                    value: (
                      <>
                        <a href={`/documents/${id}/raw/${selected.id}`} className="text-accent hover:underline" download>
                          Rohdatei
                        </a>{" "}
                        <span className="text-xs text-muted">({selected.contentType ?? "unbekannter Typ"}, nur als Download)</span>
                      </>
                    ),
                  },
                ]}
              />
            </Panel>
          )}

          <Panel
            title="Versionen"
            description="Neueste zuerst. Eine Version wählen oder mit der gewählten vergleichen."
            flush
          >
            {versions.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted">Noch keine Version archiviert.</p>
            ) : (
              <ol className="max-h-[28rem] divide-y divide-line overflow-y-auto">
                {versions.map((v) => {
                  const isSelected = v.id === selectedId;
                  return (
                    <li key={v.id} className={cx("px-4 py-2.5 text-sm", isSelected && "bg-accent-soft/60")}>
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          href={versionHref(v.id)}
                          aria-current={isSelected ? "true" : undefined}
                          className={cx("hover:underline", isSelected ? "font-semibold text-ink" : "text-accent")}
                        >
                          {fmt.dateTime(v.fetchedAt)}
                        </Link>
                        <span className="flex gap-1">
                          {v.id === document.currentVersionId && <Badge tone="ok">aktuell</Badge>}
                          {v.simulated && <Badge tone="warn">simuliert</Badge>}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted">
                        <span>
                          {v.converter} · {v.language ?? "–"} · {v.chunks} Abschnitte
                        </span>
                        {selectedId && !isSelected && (
                          <Link href={versionHref(selectedId, v.id)} className="text-accent hover:underline">
                            Vergleichen
                          </Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Panel>
        </aside>
      </div>
    </>
  );
}

function ChunkTable({ chunks }: { chunks: VersionChunk[] }) {
  return (
    <div className="-mx-5 -my-4">
      <Table>
        <thead>
          <tr>
            <th className={`${thClass} text-right`}>#</th>
            <th className={thClass}>Überschrift</th>
            <th className={`${thClass} text-right`}>Wörter</th>
            <th className={thClass}>Übernommen</th>
            <th className={thClass}>Einbettung</th>
          </tr>
        </thead>
        <tbody>
          {chunks.map((c) => (
            <tr key={c.ordinal} className={trClass}>
              <td className={`${tdClass} ${numClass}`}>{c.ordinal}</td>
              <td className={tdClass}>{c.heading ?? <span className="text-muted">–</span>}</td>
              <td className={`${tdClass} ${numClass}`}>{fmt.int(c.wordCount)}</td>
              <td className={tdClass}>{c.carried ? "übernommen" : <span className="text-muted">–</span>}</td>
              <td className={tdClass}>{c.embedded ? <Badge tone="ok">vorhanden</Badge> : <span className="text-muted">–</span>}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/** Tab "Erwähnungen und Zitate": every chunk with its mentions and quotes highlighted, and its facts. */
function Annotations({ chunks }: { chunks: ChunkAnnotations[] }) {
  if (chunks.length === 0)
    return (
      <Panel>
        <EmptyState title="Keine Abschnitte">Diese Version hat keine Abschnitte.</EmptyState>
      </Panel>
    );
  const annotated = chunks.filter((c) => c.spans.length > 0).length;
  return (
    <section className="space-y-4">
      <div className="space-y-1.5">
        <AnnotationLegend />
        <p className="text-xs text-muted">
          {annotated} von {chunks.length} Abschnitten mit Erwähnungen oder Zitaten. Facts nicht aktiver Extraktionsläufe sind grau.
        </p>
      </div>
      {chunks.map((c) => (
        <article key={c.chunkId} className="rounded-lg border border-line bg-surface">
          <h3 className="border-b border-line px-4 py-2 text-xs font-medium text-muted">
            Chunk {c.ordinal}
            {c.carriedFrom ? " · übernommen (Erwähnungen und Zitate des Ursprungs)" : ""}
          </h3>
          <p className="max-w-[72ch] px-4 py-3 text-[0.9375rem] leading-7">
            <AnnotatedText text={c.text} spans={c.spans} />
          </p>
          {c.mentions.length > 0 && (
            <ul className="flex flex-wrap gap-2 px-4 pb-3 text-xs">
              {c.mentions.map((m) => (
                <li key={m.id} className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5">
                  <Link href={`/geo/${m.geoObjectId}`} className="font-medium text-accent hover:underline">
                    {m.name ?? m.geoObjectId}
                  </Link>
                  <span className="text-muted">
                    {MATCH_KIND_LABELS[m.matchKind]}, {share(m.confidence)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {c.facts.length > 0 && (
            <div className="border-t border-line">
              <Table className="text-xs">
                <thead>
                  <tr>
                    <th className={thClass}>Attribut</th>
                    <th className={thClass}>Wert</th>
                    <th className={`${thClass} text-right`}>Konfidenz</th>
                    <th className={thClass}>Modell</th>
                    <th className={thClass}>Lauf</th>
                  </tr>
                </thead>
                <tbody>
                  {c.facts.map((f) => (
                    <tr key={f.id} className={cx(trClass, !f.active && "text-muted opacity-70")}>
                      <td className={tdClass}>
                        <Link href={`/geo/${f.geoObjectId}`} className="text-accent hover:underline">
                          {factAttributeLabel(f.attribute)}
                        </Link>
                      </td>
                      <td className={tdClass}>{formatFactValue(f.attribute, f.value)}</td>
                      <td className={`${tdClass} ${numClass}`}>{share(f.confidence)}</td>
                      <td className={tdClass}>{f.model ?? "–"}</td>
                      <td className={`${tdClass} whitespace-nowrap`}>
                        {f.runId ? (
                          <Link href={`/runs/${f.runId}`} className="font-mono text-accent hover:underline" title={f.runId}>
                            {f.runId.slice(0, 8)}
                          </Link>
                        ) : (
                          "–"
                        )}
                        {f.active ? "" : " (nicht aktiv)"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
