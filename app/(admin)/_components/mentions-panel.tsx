import { MENTIONS_PER_PAGE, type GeoMentionRow } from "@/lib/domain/geo-facts";
import { AnnotatedText } from "./annotated-text";
import { MATCH_KIND_LABELS } from "./labels";
import { Badge, EmptyState, Pagination, Panel, TextLink } from "./ui";

const share = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });

/**
 * The documents that mention a geo object, one page of its mentions with the text around each (geo page; the place
 * page's „Quellen“ tab, spec 09 „Dokumente mit Erwähnung“).
 */
export function MentionsPanel({
  mentions: mentionPage,
  page,
  pageHref,
}: {
  mentions: { rows: GeoMentionRow[]; total: number };
  page: number;
  pageHref: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(mentionPage.total / MENTIONS_PER_PAGE));
  return (
    <Panel
      title={`Erwähnungen (${mentionPage.total})`}
      description="Textstellen in Dokumenten, die diesem Geo-Objekt zugeordnet wurden."
      flush
    >
      {mentionPage.rows.length === 0 ? (
        <EmptyState title="Keine Erwähnungen.">
          Erwähnungen entstehen, wenn ein Lauf ein Dokument liest, das dieses Geo-Objekt nennt.
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {mentionPage.rows.map((m) => (
              <li key={m.id} className="space-y-1 px-4 py-3 text-sm">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <TextLink href={`/documents/${m.documentId}`} className="text-sm">
                    {m.domain}
                  </TextLink>
                  <span>{m.observedAt}</span>
                  <Badge>
                    {MATCH_KIND_LABELS[m.matchKind]} {share(m.confidence)}
                  </Badge>
                </p>
                <p className="max-w-3xl text-xs leading-relaxed text-muted">
                  <AnnotatedText
                    text={m.snippet.before + m.snippet.quote + m.snippet.after}
                    spans={[
                      {
                        start: m.snippet.before.length,
                        end: m.snippet.before.length + m.snippet.quote.length,
                        kind: "mention",
                        ref: m.id,
                      },
                    ]}
                  />
                </p>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <div className="border-t border-line">
              <Pagination page={page} pages={pages} total={mentionPage.total} noun="Erwähnungen" href={pageHref} />
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
