import Link from "next/link";
import { notFound } from "next/navigation";
import { getArchive } from "@/lib/adapters/s3";
import { getDb } from "@/lib/db/client";
import { documentDetail, versionContent, versionDiff } from "@/lib/domain/document-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { ArchiveMarkdown } from "../../_components/archive-markdown";
import { DOC_TYPE_LABELS, DOCUMENT_STATUS_LABELS, OBSERVED_AT_BASIS_LABELS } from "../../_components/labels";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIFF_STYLE = { same: "text-neutral-600", added: "bg-green-100", removed: "bg-red-100" } as const;
const DIFF_MARK = { same: " ", added: "+", removed: "-" } as const;

const param = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const time = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "–");
const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

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

  return (
    <div className="space-y-6 text-sm">
      <div>
        <p>
          <Link href={`/sources/${source.id}`} className="underline">
            ← {source.domain}
          </Link>
        </p>
        <h1 className="text-lg font-semibold break-all">{document.url}</h1>
      </div>
      {document.status === "gone" && (
        <p role="alert" className="rounded bg-amber-100 px-3 py-2">
          Die Seite ist verschwunden (zweimal 404/410); das Archiv bleibt erhalten.
        </p>
      )}
      <dl className="grid grid-cols-[10rem_1fr] gap-y-1">
        <dt>Original</dt>
        <dd>
          {isWebUrl(document.url) ? (
            <a href={document.url} target="_blank" rel="noopener noreferrer nofollow" className="underline break-all">
              Original
            </a>
          ) : (
            "Hochgeladene Datei"
          )}
        </dd>
        <dt>Quelle</dt>
        <dd>
          <Link href={`/sources/${source.id}`} className="underline">
            {source.name}
          </Link>{" "}
          ({source.domain}, {DOC_TYPE_LABELS[source.type]}, Gewicht{" "}
          {source.weight.toLocaleString("de-DE", { maximumFractionDigits: 2 })})
        </dd>
        <dt>Status</dt>
        <dd>{DOCUMENT_STATUS_LABELS[document.status]}</dd>
        <dt>Zuerst gesehen</dt>
        <dd>{time(document.firstSeenAt)}</dd>
        <dt>Zuletzt geprüft</dt>
        <dd>{time(document.lastCheckedAt)}</dd>
      </dl>

      <section>
        <h2 className="mb-1 font-semibold">Versionen</h2>
        {versions.length === 0 ? (
          <p>Noch keine Version archiviert.</p>
        ) : (
          <ol className="space-y-1">
            {versions.map((v) => (
              <li key={v.id} className={v.id === selectedId ? "font-semibold" : undefined}>
                <Link href={versionHref(v.id)} className="underline">
                  {time(v.fetchedAt)}
                </Link>{" "}
                <span className="font-mono text-xs">{v.hash8}</span> · {v.converter} · {v.language ?? "–"} · beobachtet{" "}
                {v.observedAt} ({OBSERVED_AT_BASIS_LABELS[v.basis]})
                {v.publishedAt ? ` · veröffentlicht ${v.publishedAt}` : ""} · {v.chunks} Chunks, {v.carried} übernommen
                {v.simulated ? " · simuliert" : ""}
                {v.id === document.currentVersionId ? " · aktuell" : ""}
                {selectedId && v.id !== selectedId && (
                  <>
                    {" "}
                    ·{" "}
                    <Link href={versionHref(selectedId, v.id)} className="underline">
                      Vergleichen
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {selected && (
        <p>
          <a href={`/documents/${id}/raw/${selected.id}`} className="underline" download>
            Rohdatei
          </a>{" "}
          <span className="text-neutral-500">({selected.contentType ?? "unbekannter Typ"}, nur als Download)</span>
        </p>
      )}

      {diff && compareId && (
        <section>
          <h2 className="mb-1 font-semibold">
            Änderungen seit {time(versions.find((v) => v.id === compareId)!.fetchedAt)}
          </h2>
          <pre className="overflow-x-auto rounded border border-neutral-300 p-2 text-xs whitespace-pre-wrap">
            {diff.map((line, i) => (
              <div key={i} className={DIFF_STYLE[line.kind]}>
                {DIFF_MARK[line.kind]} {line.text}
              </div>
            ))}
          </pre>
        </section>
      )}

      {selected && !content && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2">
          Das Markdown dieser Version fehlt im Archiv.
        </p>
      )}
      {content && (
        <>
          <section>
            <h2 className="mb-1 font-semibold">Inhalt</h2>
            <div className="max-w-3xl space-y-2 rounded border border-neutral-300 p-3">
              <ArchiveMarkdown markdown={content.markdown} />
            </div>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">Chunks ({content.chunks.length})</h2>
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-neutral-300">
                  <th className="py-1 pr-4">#</th>
                  <th className="pr-4">Überschrift</th>
                  <th className="pr-4">Wörter</th>
                  <th className="pr-4">Übernommen</th>
                  <th>Embedding</th>
                </tr>
              </thead>
              <tbody>
                {content.chunks.map((c) => (
                  <tr key={c.ordinal} className="border-b border-neutral-200">
                    <td className="py-1 pr-4 tabular-nums">{c.ordinal}</td>
                    <td className="pr-4">{c.heading ?? "–"}</td>
                    <td className="pr-4 tabular-nums">{c.wordCount}</td>
                    <td className="pr-4">{c.carried ? "übernommen" : "–"}</td>
                    <td>{c.embedded ? "Embedding" : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
