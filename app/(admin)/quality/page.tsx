import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { activeSubdivisionKeys, listSubdivisionOptions } from "@/lib/domain/subdivisions/store";
import { comparisonOverview } from "@/lib/domain/comparison";
import { requireAdmin } from "@/lib/security/require-admin";
import { SubdivisionOptions } from "../_components/subdivision-options";
import { PLACE_KIND_LABELS, qualityPageError } from "../_components/labels";
import { Button, ButtonLink, EmptyState, Field, FilterChips, inputClass, Mono, Notice, PageHeader, Panel, Stat } from "../_components/ui";
import { saveComparisonSelectionAction } from "./actions";

export const metadata: Metadata = { title: "Qualität" };

const querySchema = z.object({
  subdivision: z.string().optional().catch(undefined),
  tile: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
});

export default async function Page({ searchParams }: PageProps<"/quality">) {
  await requireAdmin();
  const query = querySchema.parse(await searchParams);
  const db = getDb();
  // the subdivisions with tiles (built or in work), by country and name
  const withTiles = new Set(await activeSubdivisionKeys(db));
  const options = (await listSubdivisionOptions(db)).filter((o) => withTiles.has(o.key));
  const subdivision = options.find((o) => o.key === query.subdivision) ?? options[0];
  if (!subdivision)
    return (
      <>
        <PageHeader title="Qualität" />
        <Notice tone="warn">Noch kein Landesteil mit Kacheln – zuerst einen Landesteil aufbauen.</Notice>
      </>
    );
  const overview = await comparisonOverview(db, subdivision.key);

  const { candidates, size } = overview ?? { candidates: [], size: 0 };
  const target = getConfig().quality.comparisonSet.pilotSize;
  const tileIds = [...new Set(candidates.flatMap((c) => (c.tileId ? [c.tileId] : [])))];
  const tile = tileIds.includes(query.tile ?? "") ? query.tile : undefined;
  const shown = tile ? candidates.filter((c) => c.tileId === tile) : candidates;
  const href = (t?: string) => `/quality?${new URLSearchParams({ subdivision: subdivision.key, ...(t ? { tile: t } : {}) })}`;
  const remaining = Math.max(0, target - size);
  const error = qualityPageError(query.error);

  return (
    <>
      <PageHeader
        title="Qualität"
        description={`Der Vergleichssatz ist eine feste Auswahl bestätigter Orte, an der die Ergebnisse gegen eine externe Referenz (Navily) geprüft werden; Ziel sind ${target} Orte.`}
        actions={
          <ButtonLink href={`/quality/compare?${new URLSearchParams({ subdivision: subdivision.key })}`} variant="primary">
            Navily-Abgleich
          </ButtonLink>
        }
      />

      <form method="get" className="mb-6 flex flex-wrap items-end gap-3">
        <Field label="Landesteil">
          <select name="subdivision" defaultValue={subdivision.key} className={inputClass} aria-label="Landesteil">
            <SubdivisionOptions options={options} />
          </select>
        </Field>
        <Button>Anzeigen</Button>
      </form>

      {!overview && (
        <Notice tone="warn" className="mb-6" data-testid="subdivision-missing">
          Landesteil nicht gefunden –{" "}
          <Link href="/runs" className="font-medium text-accent underline-offset-2 hover:underline">
            Läufe ansehen
          </Link>
        </Notice>
      )}
      {error && (
        <Notice tone="danger" className="mb-6">
          {error}
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Vergleichssatz"
          value={
            <span data-testid="comparison-count" className="tabular-nums">
              {size} von {target}
            </span>
          }
          tone={size >= target ? "ok" : "neutral"}
          hint={
            remaining > 0
              ? `Orte im Landesteil ${subdivision.name}; noch ${remaining} auswählen`
              : `Orte im Landesteil ${subdivision.name}; Ziel erreicht`
          }
        />
      </div>

      <Panel
        title="Vergleichssatz"
        description="Haken setzen oder entfernen und „Auswahl speichern“ klicken. Nur die Ortsliste festlegen, keine Navily-Daten übernehmen."
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
            Orte entstehen nach dem Gazetteer- und dem Seed-Lauf für den Landesteil und werden in der Prüfung bestätigt.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState title="Keine bestätigten Orte">
            Ortskandidaten werden in der Prüfung bestätigt; erst dann lassen sie sich hier auswählen.
          </EmptyState>
        ) : (
          <form action={saveComparisonSelectionAction}>
            <input type="hidden" name="subdivisionKey" value={subdivision.key} />
            <ul className="divide-y divide-line">
              {shown.map((c) => (
                <li key={c.placeId} className="hover:bg-sunken/50">
                  <label className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                    <input type="hidden" name="shown" value={c.placeId} />
                    <input
                      type="checkbox"
                      name="include"
                      value={c.placeId}
                      defaultChecked={c.inSet}
                      aria-label={`${c.name ?? c.placeId} im Vergleichssatz`}
                      className="size-4 accent-accent"
                    />
                    <Link href={`/places/${c.placeId}`} className="font-medium text-accent hover:underline">
                      {c.name ?? c.placeId}
                    </Link>
                    <span className="text-muted">{PLACE_KIND_LABELS[c.kind]}</span>
                    {c.tileId && <Mono>{c.tileId}</Mono>}
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-3 border-t border-line px-4 py-3">
              <span className="text-xs text-muted">Speichert alle Haken dieser Liste auf einmal.</span>
              <Button type="submit" size="sm" variant="primary">
                Auswahl speichern
              </Button>
            </div>
          </form>
        )}
      </Panel>
    </>
  );
}
