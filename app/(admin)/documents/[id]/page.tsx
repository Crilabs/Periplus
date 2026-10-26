import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getArchive } from "@/lib/adapters/s3";
import { getDb } from "@/lib/db/client";
import { documentDetail, versionContent, versionDiff } from "@/lib/domain/document-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { ArchiveMarkdown } from "../../_components/archive-markdown";
import { DiffView } from "../../_components/diff-view";
import { DOC_TYPE_LABELS, DOCUMENT_STATUS_LABELS, OBSERVED_AT_BASIS_LABELS } from "../../_components/labels";
import {
  Badge,
  buttonClass,
  cx,
  DescriptionList,
  EmptyState,
  fmt,
  Mono,
  Notice,
  PageHeader,
  Panel,
  TextLink,
} from "../../_components/ui";

export const metadata: Metadata = { title: "Dokument" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const param = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const isWebUrl = (url: string) => /^https?:\/\//i.test(url);
const share = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });

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
  const archive = getArchive();
  const [content, diff] = await Promise.all([
    selectedId ? versionContent(db, archive, id, selectedId) : null,
    selectedId && compareId && compareId !== selectedId ? versionDiff(db, archive, id, compareId, selectedId) : null,
  ]);
  const selected = versions.find((v) => v.id === selectedId);
  const versionHref = (v: string, compare?: string) => `/documents/${id}?v=${v}${compare ? `&diff=${compare}` : ""}`;
  const compared = compareId ? versions.find((v) => v.id === compareId) : undefined;
  const now = new Date();

  return (
    <>
      <PageHeader
        title={<span className="break-all">{document.url}</span>}
        back={{ href: "/", label: "Übersicht" }}
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
                  description={`Text der Version vom ${fmt.dateTime(selected.fetchedAt)}, wie er archiviert wurde.`}
                >
                  <div className="px-1 py-2 sm:px-4">
                    <ArchiveMarkdown markdown={content.markdown} />
                  </div>
                </Panel>
              )}
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
                      <span className="font-medium">{source.name}</span>
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
                          {v.converter} · {v.language ?? "–"}
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
