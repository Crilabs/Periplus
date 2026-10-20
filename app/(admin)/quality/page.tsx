import Link from "next/link";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { COMPARISON_TARGET, comparisonOverview } from "@/lib/domain/comparison";
import { requireAdmin } from "@/lib/security/require-admin";
import { PLACE_KIND_LABELS } from "../_components/labels";
import { Button, ButtonLink, EmptyState, FilterChips, Mono, Notice, PageHeader, Panel, Stat } from "../_components/ui";
import { toggleComparisonAction } from "./actions";

const querySchema = z.object({
  area: z.string().optional().catch(undefined),
  tile: z.string().optional().catch(undefined),
});

export default async function Page({ searchParams }: PageProps<"/quality">) {
  await requireAdmin();
  const areas = getConfig().areas;
  const query = querySchema.parse(await searchParams);
  const area = areas.find((a) => a.key === query.area) ?? areas[0];
  if (!area)
    return (
      <>
        <PageHeader title="Qualität" />
        <Notice tone="warn">Kein Revier konfiguriert.</Notice>
      </>
    );
  const overview = await comparisonOverview(getDb(), area.key);
  const { candidates, size } = overview ?? { candidates: [], size: 0 };
  const tileIds = [...new Set(candidates.flatMap((c) => (c.tileId ? [c.tileId] : [])))];
  const tile = tileIds.includes(query.tile ?? "") ? query.tile : undefined;
  const shown = tile ? candidates.filter((c) => c.tileId === tile) : candidates;
  const href = (t?: string) => `/quality?${new URLSearchParams({ area: area.key, ...(t ? { tile: t } : {}) })}`;
  const remaining = Math.max(0, COMPARISON_TARGET - size);

  return (
    <>
      <PageHeader
        title="Qualität"
        description={`Der Vergleichssatz ist eine feste Auswahl bestätigter Orte je Revier. An ihm wird die Qualität der Ergebnisse gegen eine externe Referenz (Navily) gemessen; Ziel sind ${COMPARISON_TARGET} Orte.`}
        actions={
          <ButtonLink href={`/quality/compare?area=${area.key}`} variant="primary">
            Mit Navily vergleichen
          </ButtonLink>
        }
      />

      {areas.length > 1 && (
        <div className="mb-6">
          <FilterChips
            label="Revier"
            items={areas.map((a) => ({ href: `/quality?area=${a.key}`, label: a.names.de, current: a.key === area.key }))}
          />
        </div>
      )}

      {!overview && (
        <Notice tone="warn" className="mb-6" data-testid="area-missing">
          Revier noch nicht angelegt –{" "}
          <Link href="/runs" className="font-medium text-accent underline-offset-2 hover:underline">
            Gazetteer-Lauf starten
          </Link>
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Vergleichssatz"
          value={
            <span data-testid="comparison-count" className="tabular-nums">
              {size} von {COMPARISON_TARGET}
            </span>
          }
          tone={size >= COMPARISON_TARGET ? "ok" : "neutral"}
          hint={
            remaining > 0
              ? `Orte im Revier ${area.names.de}; noch ${remaining} auswählen`
              : `Orte im Revier ${area.names.de}; Ziel erreicht`
          }
        />
        <Stat
          label="Bestätigte Orte"
          value={candidates.length}
          hint="Nur bestätigte, gültige Orte können in den Vergleichssatz"
        />
        <Stat label="Kacheln" value={tileIds.length} hint="Kacheln des Reviers mit mindestens einem bestätigten Ort" />
      </div>

      <Panel
        title="Vergleichssatz"
        description="Haken setzen oder entfernen und „Übernehmen“ klicken. Nur die Ortsliste festlegen, keine Navily-Daten übernehmen."
        className="mt-6"
        flush
      >
        {tileIds.length > 0 && (
          <div className="border-b border-line px-4 py-3">
            <FilterChips
              label="Kachel"
              items={[
                { href: href(), label: "Alle Kacheln", current: !tile, count: candidates.length },
                ...tileIds.map((t) => ({
                  href: href(t),
                  label: <span className="font-mono text-xs">{t}</span>,
                  current: t === tile,
                  count: candidates.filter((c) => c.tileId === t).length,
                })),
              ]}
            />
          </div>
        )}
        {!overview ? (
          <EmptyState title="Noch keine Orte">
            Orte entstehen nach dem Gazetteer- und dem Seed-Lauf für das Revier und werden in der Prüfung bestätigt.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState title="Keine bestätigten Orte">
            Ortskandidaten werden in der Prüfung bestätigt; erst dann lassen sie sich hier auswählen.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((c) => (
              <li key={c.placeId} className="hover:bg-sunken/50">
                <form action={toggleComparisonAction} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                  <input type="hidden" name="placeId" value={c.placeId} />
                  <input type="hidden" name="areaKey" value={area.key} />
                  <input
                    type="checkbox"
                    name="include"
                    value="true"
                    defaultChecked={c.inSet}
                    aria-label={`${c.name ?? c.placeId} im Vergleichssatz`}
                    className="size-4 accent-accent"
                  />
                  <Link href={`/places/${c.placeId}`} className="font-medium text-accent hover:underline">
                    {c.name ?? c.placeId}
                  </Link>
                  <span className="text-muted">{PLACE_KIND_LABELS[c.kind]}</span>
                  {c.tileId && <Mono>{c.tileId}</Mono>}
                  <Button type="submit" size="sm" variant="ghost" className="ml-auto">
                    Übernehmen
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
