import Link from "next/link";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { DELIVERIES_PAGE_SIZE, listDeliveries } from "@/lib/domain/delivery/view";
import { requireAdmin } from "@/lib/security/require-admin";
import { CHECK_LABELS, DELIVERY_STATUS_LABELS, runScopeError } from "../_components/labels";
import {
  Badge,
  Button,
  cx,
  EmptyState,
  FilterChips,
  fmt,
  Mono,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Table,
  tdClass,
  TextLink,
  thClass,
  trClass,
} from "../_components/ui";
import { buildDeliveryAction } from "./actions";
import { DELIVERY_STATUS_TONES } from "./status";

/** Object counts of a row in a short, fixed order. */
const COUNT_LABELS: Array<[string, string]> = [
  ["spots", "Spots"],
  ["highlights", "Highlights"],
  ["regions", "Regionen"],
  ["changes", "Änderungen"],
];

const pageParam = z.coerce.number().int().min(1).catch(1);
const areaParam = z.uuid().optional().catch(undefined);

export default async function Page({ searchParams }: PageProps<"/deliveries">) {
  await requireAdmin();
  const sp = await searchParams;
  const error = runScopeError(sp.error);
  const page = pageParam.parse(sp.page);
  const areaId = areaParam.parse(sp.area);
  const { areas, rows, total } = await listDeliveries(getDb(), { areaId, page });
  const pages = Math.max(1, Math.ceil(total / DELIVERIES_PAGE_SIZE));
  const href = (p: number, area = areaId) => {
    const q = new URLSearchParams();
    if (area) q.set("area", area);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `/deliveries?${s}` : "/deliveries";
  };

  return (
    <>
      <PageHeader
        title="Lieferungen"
        description="Je Revier ein Paket nach dem Liefervertrag: bauen, den Validierungsbericht prüfen, Dateien herunterladen. Nur gültige Pakete gehen über die API hinaus; abgelehnte bleiben zur Diagnose gespeichert."
      />
      {error && (
        <Notice tone="danger" className="mb-6">
          Paket nicht gebaut: {error}
        </Notice>
      )}

      {areas.length === 0 ? (
        <Panel className="mb-6">
          <EmptyState title="Noch kein Revier">Ein Revier entsteht mit dem ersten Gazetteer-Lauf; danach lässt sich hier sein Paket bauen.</EmptyState>
        </Panel>
      ) : (
        <ul className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Reviere">
          {areas.map((a) => (
            <li key={a.geoObjectId} className="flex items-start justify-between gap-4 rounded-lg border border-line bg-surface px-4 py-3">
              <div className="min-w-0">
                <p className="font-medium">{a.name}</p>
                <p className="mt-0.5 text-xs text-muted">
                  <Mono>{a.key}</Mono>
                </p>
                <p className="mt-2 text-sm">
                  {a.current ? (
                    <>
                      Version <span className="font-semibold tabular-nums">{a.current.dataVersion}</span>
                      <span className="text-muted"> · {fmt.dateTime(a.current.generatedAt)}</span>
                    </>
                  ) : (
                    <span className="text-muted">Noch kein gültiges Paket</span>
                  )}
                </p>
              </div>
              <form action={buildDeliveryAction}>
                <input type="hidden" name="areaId" value={a.geoObjectId} />
                <Button
                  size="sm"
                  variant="primary"
                  title="Startet einen Lauf, der das Paket des Reviers aus den aktuellen Profilen baut, prüft und speichert."
                  aria-label={`Paket bauen: ${a.name}`}
                >
                  Paket bauen
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <Panel
        title="Pakete"
        description="Jeder Bau, neueste zuerst. „Unverändert“: gültig, aber ohne Änderung zum vorigen Paket, daher ohne neue Version und ohne Dateien."
        actions={
          areas.length > 1 && (
            <FilterChips
              label="Revier"
              items={[
                { href: href(1, undefined), label: "Alle", current: !areaId },
                ...areas.map((a) => ({ href: href(1, a.geoObjectId), label: a.name, current: areaId === a.geoObjectId })),
              ]}
            />
          )
        }
        flush
      >
        {rows.length === 0 ? (
          <EmptyState title="Noch kein Paket gebaut">„Paket bauen“ bei einem Revier startet den ersten Bau.</EmptyState>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th className={thClass}>Revier</th>
                  <th className={thClass}>Status</th>
                  <th className={cx(thClass, "text-right")}>Version</th>
                  <th className={thClass}>Zeitpunkt</th>
                  <th className={thClass}>Fehlgeschlagene Prüfungen</th>
                  <th className={thClass}>Objekte</th>
                  <th className={thClass}>Lauf</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={trClass}>
                    <td className={tdClass}>
                      <TextLink href={`/deliveries/${r.id}`}>{r.areaName}</TextLink>
                    </td>
                    <td className={tdClass}>
                      <Badge tone={DELIVERY_STATUS_TONES[r.status]}>{DELIVERY_STATUS_LABELS[r.status]}</Badge>
                    </td>
                    <td className={cx(tdClass, "text-right tabular-nums")}>{r.dataVersion ?? "–"}</td>
                    <td className={cx(tdClass, "whitespace-nowrap")}>{fmt.dateTime(r.generatedAt)}</td>
                    <td className={tdClass}>
                      {r.failedChecks.length === 0 ? (
                        <span className="text-muted">keine</span>
                      ) : (
                        <ul className="space-y-0.5 text-danger">
                          {r.failedChecks.map((c) => (
                            <li key={c}>{CHECK_LABELS[c]}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className={cx(tdClass, "whitespace-nowrap text-xs text-muted tabular-nums")}>
                      {COUNT_LABELS.filter(([k]) => r.objectCounts[k] !== undefined)
                        .map(([k, label]) => `${fmt.int(r.objectCounts[k]!)} ${label}`)
                        .join(" · ")}
                    </td>
                    <td className={tdClass}>
                      {r.runId ? (
                        <Link href={`/runs/${r.runId}`} className="font-mono text-[0.8125rem] text-accent hover:underline" title={r.runId}>
                          {r.runId.slice(0, 8)}
                        </Link>
                      ) : (
                        <span className="text-muted">–</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {pages > 1 && <Pagination page={page} pages={pages} total={total} noun="Pakete" href={(p) => href(p)} />}
          </>
        )}
      </Panel>
    </>
  );
}
