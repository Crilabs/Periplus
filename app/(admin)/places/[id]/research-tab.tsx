import type { ResearchRow } from "@/lib/domain/research/view";
import { PAGE_KIND_LABELS } from "../../_components/labels";
import { Badge, EmptyState, Panel, Table, tdClass, TextLink, thClass, trClass } from "../../_components/ui";

const PURPOSE_LABELS = { positive: "Bestätigung", negative: "Negativsuche" } as const;

/**
 * Tab „Recherche“ of the place page (plan N1): the search hits of the berth with search term, page kind, first-hand
 * and SEO/AI flags, observation date and the berths the page names.
 */
export function ResearchTab({ rows }: { rows: ResearchRow[] }) {
  if (rows.length === 0) {
    return (
      <Panel>
        <EmptyState title="Noch keine Recherche für diesen Liegeplatz." />
      </Panel>
    );
  }
  return (
    <Panel flush>
      <Table>
        <thead>
          <tr>
            <th className={thClass}>Zweck</th>
            <th className={thClass}>Rang</th>
            <th className={thClass}>Suchbegriff</th>
            <th className={thClass}>Seite</th>
            <th className={thClass}>Art</th>
            <th className={thClass}>Merkmale</th>
            <th className={thClass}>Beobachtet</th>
            <th className={thClass}>Genannte Liegeplätze</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.purpose}:${r.url}`} className={trClass}>
              <td className={tdClass}>{PURPOSE_LABELS[r.purpose]}</td>
              <td className={tdClass}>{r.rank}</td>
              <td className={tdClass}>{r.keyword}</td>
              <td className={tdClass}>
                {r.documentId ? (
                  <TextLink href={`/documents/${r.documentId}`} title={r.url}>
                    {r.domain}
                  </TextLink>
                ) : (
                  <a href={r.url} target="_blank" rel="noreferrer noopener" className="break-all text-accent hover:underline">
                    {r.domain}
                  </a>
                )}
              </td>
              <td className={tdClass}>{r.assessment ? PAGE_KIND_LABELS[r.assessment.pageKind] : "–"}</td>
              <td className={tdClass}>
                {r.assessment && (
                  <span className="flex flex-wrap gap-1">
                    {r.assessment.firstHand && <Badge tone="ok">erste Hand</Badge>}
                    {r.assessment.generated && <Badge tone="warn">SEO/KI</Badge>}
                  </span>
                )}
              </td>
              <td className={tdClass}>{r.assessment?.observedAt ?? "–"}</td>
              <td className={tdClass}>{r.assessment && r.assessment.berths.length > 0 ? r.assessment.berths.join(", ") : "–"}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}
