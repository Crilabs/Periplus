import type { Metadata } from "next";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { countrySummaryText, SUBDIVISION_STATUSES, subdivisionTree, type SubdivisionRow, type SubdivisionStatus } from "@/lib/domain/subdivisions/view";
import { requireAdmin } from "@/lib/security/require-admin";
import {
  Badge,
  Button,
  cx,
  EmptyState,
  FilterChips,
  fmt,
  Mono,
  Notice,
  numClass,
  PageHeader,
  Panel,
  Table,
  tdClass,
  TextLink,
  thClass,
  trClass,
} from "../_components/ui";
import { buildSubdivisionAction, queueCountryAction, rebuildSubdivisionsAction } from "./actions";
import { SUBDIVISION_STATUS_TONES } from "./status";

export const metadata: Metadata = { title: "Länder und Landesteile" };

const statusParam = z.enum(SUBDIVISION_STATUSES).optional().catch(undefined);
const queuedParam = z.coerce.number().int().min(0).optional().catch(undefined);

function SubdivisionRows({ rows, country }: { rows: SubdivisionRow[]; country: string }) {
  return (
    <Table>
      <thead>
        <tr>
          <th className={thClass}>Landesteil</th>
          <th className={thClass}>Status</th>
          <th className={cx(thClass, "text-right")}>Küstenkacheln</th>
          <th className={cx(thClass, "text-right")}>davon bearbeitet</th>
          <th className={thClass}>Letzter Lauf</th>
          <th className={cx(thClass, "text-right")}>Kosten</th>
          <th className={thClass}>
            <span className="sr-only">Aktion</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.key} className={trClass}>
            <td className={tdClass}>
              <TextLink href={`/subdivisions/${encodeURIComponent(s.key)}`}>{s.name}</TextLink>
              <span className="ml-2 text-xs text-muted">
                <Mono>{s.key}</Mono>
              </span>
            </td>
            <td className={tdClass}>
              <Badge tone={SUBDIVISION_STATUS_TONES[s.status]} title={s.statusReason ?? undefined}>
                {s.status}
              </Badge>
              {s.queued && <span className="ml-2 text-xs text-muted">wartet</span>}
              {s.status === "ausgeschlossen" && s.statusReason && <p className="mt-1 text-xs text-muted">{s.statusReason}</p>}
            </td>
            <td className={cx(tdClass, numClass)}>{fmt.int(s.coastTiles)}</td>
            <td className={cx(tdClass, numClass)}>{fmt.int(s.processedTiles)}</td>
            <td className={cx(tdClass, "whitespace-nowrap")}>{fmt.dateTime(s.lastRunAt ? new Date(s.lastRunAt) : null)}</td>
            <td className={cx(tdClass, numClass)}>{fmt.eur(s.costEur)}</td>
            <td className={cx(tdClass, "text-right")}>
              {s.status !== "ausgeschlossen" && s.status !== "läuft" && (
                <form action={buildSubdivisionAction}>
                  <input type="hidden" name="subdivisionKey" value={s.key} />
                  <Button
                    size="sm"
                    variant={s.status === "aufgebaut" ? "secondary" : "primary"}
                    aria-label={`Aufbauen: ${s.name}`}
                    title={`Startet den Aufbau von ${s.name} (${country}): Gazetteer, Datensätze, Seed, Geometrie, Discovery.`}
                  >
                    Aufbauen
                  </Button>
                </form>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default async function Page({ searchParams }: PageProps<"/subdivisions">) {
  await requireAdmin();
  const sp = await searchParams;
  const status = statusParam.parse(sp.status);
  const queued = queuedParam.parse(sp.queued);
  const tree = await subdivisionTree(getDb());
  const filtered = tree
    .map((c) => ({ ...c, subdivisions: status ? c.subdivisions.filter((s) => s.status === status) : c.subdivisions }))
    .filter((c) => c.subdivisions.length > 0);
  const counts = Object.fromEntries(SUBDIVISION_STATUSES.map((st) => [st, tree.reduce((n, c) => n + c.subdivisions.filter((s) => s.status === st).length, 0)]));
  const href = (st?: SubdivisionStatus) => (st ? `/subdivisions?status=${encodeURIComponent(st)}` : "/subdivisions");

  return (
    <>
      <PageHeader
        title="Länder und Landesteile"
        description="Je Land seine Landesteile mit Mittelmeerküste. „Aufbauen“ startet Gazetteer, Datensätze, Seed, Geometrie und Discovery für einen Landesteil; „Alle offenen aufbauen“ stellt die nicht begonnenen Landesteile eines Landes nacheinander in die Warteschlange. Abruf, Texte und Paket bleiben eigene Läufe."
        actions={
          <form action={rebuildSubdivisionsAction}>
            <Button title="Lädt Meere, Länder und Verwaltungseinheiten neu und bildet daraus die Landesteile. Aufgebaute Landesteile bleiben, wie sie sind.">
              Landesteile neu bilden
            </Button>
          </form>
        }
      />
      {queued !== undefined && (
        <Notice tone="ok" className="mb-6">
          {queued === 0 ? "Nichts Neues in die Warteschlange gestellt." : `${queued} Landesteile in die Warteschlange gestellt.`}
        </Notice>
      )}
      <div className="mb-6">
        <FilterChips
          label="Status"
          items={[
            { href: href(), label: "Alle", current: !status },
            ...SUBDIVISION_STATUSES.map((st) => ({ href: href(st), label: st, count: counts[st], current: status === st })),
          ]}
        />
      </div>
      {tree.length === 0 ? (
        <Panel>
          <EmptyState title="Noch keine Landesteile">
            „Landesteile neu bilden“ lädt Meere, Länder und Verwaltungseinheiten (Grob-Gazetteer) und bildet daraus die Landesteile.
          </EmptyState>
        </Panel>
      ) : filtered.length === 0 ? (
        <Panel>
          <EmptyState title="Kein Landesteil mit diesem Status" />
        </Panel>
      ) : (
        <ul className="space-y-3" aria-label="Länder">
          {filtered.map((c) => (
            <li key={c.country}>
              <details className="group rounded-lg border border-line bg-surface" open={c.whole || status !== undefined}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3">
                  <span className="min-w-0">
                    <span className="font-medium">{c.name}</span>
                    <span className="ml-2 text-xs text-muted">
                      <Mono>{c.country}</Mono>
                      {c.whole ? " · als Ganzes ein Landesteil" : ""}
                    </span>
                    <span className="mt-0.5 block text-sm text-muted">{countrySummaryText(c.summary)}</span>
                  </span>
                  {!c.whole && c.subdivisions.some((s) => s.status === "nicht begonnen" && !s.queued) && (
                    <form action={queueCountryAction}>
                      <input type="hidden" name="country" value={c.country} />
                      <Button size="sm" aria-label={`Alle offenen aufbauen: ${c.name}`}>
                        Alle offenen aufbauen
                      </Button>
                    </form>
                  )}
                </summary>
                <div className="border-t border-line">
                  <SubdivisionRows rows={c.subdivisions} country={c.name} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
