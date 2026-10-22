import type { PlaceHighlights } from "@/lib/domain/highlights/view";
import { EmptyState, Panel, TextLink } from "../../_components/ui";

/** The highlights of a place per category („nur das“, „einiges mehr“, „sehr viel mehr“) with links to the POIs. Read-only. */
export function HighlightsPanel({ categories }: { categories: PlaceHighlights[] }) {
  return (
    <Panel title="Highlights" description="Sehenswertes in der Nähe, je Kategorie nach Rang" flush={categories.length === 0}>
      {categories.length === 0 ? (
        <EmptyState title="Keine Highlights.">Für diesen Ort liegt keine Auswahl vor.</EmptyState>
      ) : (
        <ul className="space-y-4 text-sm">
          {categories.map((c) => (
            <li key={c.category}>
              <p className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{c.label}</span>
                <span className="text-xs text-muted">{c.levelLabel}</span>
              </p>
              {c.highlights.length > 0 && (
                <ol className="mt-1 space-y-0.5">
                  {c.highlights.map((h) => (
                    <li key={h.geoObjectId} className="flex items-baseline justify-between gap-3">
                      <TextLink href={`/geo/${h.geoObjectId}`} className="min-w-0 break-words">
                        {h.name ?? h.geoObjectId.slice(0, 8)}
                      </TextLink>
                      <span className="shrink-0 text-xs text-muted">
                        Bedeutung {h.importance} · {h.distanceKm.toFixed(1).replace(".", ",")} km
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {c.others > 0 && <p className="mt-1 text-xs text-muted">und {c.others} weitere Kandidaten</p>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
