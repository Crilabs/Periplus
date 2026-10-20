import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { overview, REVIEW_KINDS } from "@/lib/domain/overview";
import { requireAdmin } from "@/lib/security/require-admin";
import { AutoRefresh } from "./_components/auto-refresh";
import { DELIVERY_STATUS_LABELS, REVIEW_KIND_LABELS } from "./_components/labels";
import { RunsTable } from "./_components/runs-table";
import { Badge, ButtonLink, EmptyState, fmt, Meter, Mono, PageHeader, Panel, Stat, StatusDot, TextLink } from "./_components/ui";
import { DELIVERY_STATUS_TONES } from "./deliveries/status";

export default async function Page() {
  await requireAdmin();
  const data = await overview(getDb());
  const openTotal = Object.values(data.openReviewTasks).reduce((a, b) => a + b, 0);
  const openKinds = REVIEW_KINDS.filter((k) => data.openReviewTasks[k] > 0);
  const queues = Object.entries(data.jobs);
  const busyQueues = queues.filter(([, s]) => s.queued + s.active + s.failed > 0 || s.paused);
  const sum = (key: "queued" | "active" | "failed") => queues.reduce((n, [, s]) => n + s[key], 0);
  const [queued, active, failed] = [sum("queued"), sum("active"), sum("failed")];
  const spentToday = data.budgets.reduce((n, b) => n + b.spentEur, 0);
  const budgetToday = data.budgets.reduce((n, b) => n + b.budgetEur, 0);
  const tightest = data.budgets.reduce((max, b) => Math.max(max, b.ratio), 0);
  const worker = data.workers[0];

  return (
    <>
      <AutoRefresh intervalMs={5000} />
      <PageHeader
        title="Übersicht"
        description="Was auf eine Entscheidung wartet, ob die Verarbeitung läuft und was sie heute kostet. Die Seite aktualisiert sich alle fünf Sekunden."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Offene Prüfungen"
          value={openTotal}
          tone={openTotal > 0 ? "warn" : "neutral"}
          href="/review"
          hint={openTotal > 0 ? "Warten auf eine Entscheidung" : "Nichts zu entscheiden"}
        />
        <Stat
          label="Worker"
          value={
            <span className="flex items-center gap-2 text-lg">
              <StatusDot tone={worker ? "ok" : "danger"} pulse={!!worker && active > 0} />
              {worker ? (data.workers.length > 1 ? `${data.workers.length} aktiv` : "Aktiv") : "Kein Worker"}
            </span>
          }
          tone={worker ? "neutral" : "danger"}
          hint={
            worker
              ? `Letztes Lebenszeichen vor ${fmt.duration(worker.beatAgeSeconds)}`
              : "Ohne Worker bleiben alle Jobs liegen. Mit npm run worker starten."
          }
        />
        <Stat
          label="Jobs"
          value={active > 0 ? `${active} aktiv` : queued > 0 ? `${queued} wartend` : "Leerlauf"}
          tone={failed > 0 ? "danger" : active > 0 ? "accent" : "neutral"}
          href="/jobs"
          hint={
            failed > 0
              ? `${failed} fehlgeschlagen`
              : active > 0 && queued > 0
                ? `${queued} weitere wartend`
                : "Keine Fehler"
          }
        />
        <Stat
          label="Kosten heute"
          value={fmt.eur(spentToday)}
          tone={tightest >= 1 ? "danger" : tightest >= 0.8 ? "warn" : "neutral"}
          href="/costs"
          hint={`von ${fmt.eur(budgetToday, 0)} Tagesbudget`}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel
            title="Offene Prüfungen"
            description="Aufgaben, bei denen die Pipeline eine menschliche Entscheidung braucht."
            actions={openTotal > 0 && <ButtonLink href="/review" size="sm" variant="primary">Prüfen</ButtonLink>}
            flush
          >
            {openKinds.length === 0 ? (
              <EmptyState title="Alles entschieden">
                Neue Aufgaben erscheinen hier, sobald ein Lauf etwas findet, das er nicht allein entscheiden darf.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {openKinds.map((kind) => (
                  <li key={kind}>
                    <Link
                      href={`/review?kind=${kind}`}
                      className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-sunken/50"
                    >
                      {REVIEW_KIND_LABELS[kind]}
                      <span className="font-semibold tabular-nums">{data.openReviewTasks[kind]}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Letzte Läufe"
            actions={<TextLink href="/runs" className="text-sm">Alle Läufe</TextLink>}
            flush
          >
            <RunsTable runs={data.recentRuns} />
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel
            title="Letzte Lieferungen"
            actions={<TextLink href="/deliveries" className="text-sm">Lieferungen</TextLink>}
            flush
          >
            {data.recentDeliveries.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted">Noch kein Paket gebaut.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {data.recentDeliveries.map((d) => (
                  <li key={d.id}>
                    <Link href={`/deliveries/${d.id}`} className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-sunken/50">
                      <span className="min-w-0 truncate">
                        {d.areaName ?? "Revier"}
                        {d.dataVersion !== null && <span className="text-muted tabular-nums"> · Version {d.dataVersion}</span>}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge tone={DELIVERY_STATUS_TONES[d.status]}>{DELIVERY_STATUS_LABELS[d.status]}</Badge>
                        <span className="text-xs whitespace-nowrap text-muted">{fmt.dateTime(d.generatedAt)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Warteschlangen"
            description={
              busyQueues.length === 0
                ? `Alle ${queues.length} Warteschlangen sind leer.`
                : `${busyQueues.length} von ${queues.length} Warteschlangen haben Jobs.`
            }
            actions={<TextLink href="/jobs" className="text-sm">Jobs</TextLink>}
            flush
          >
            {busyQueues.length > 0 ? (
              <ul className="divide-y divide-line text-sm">
                {busyQueues.map(([queue, s]) => (
                  <li key={queue} className="flex items-center justify-between gap-3 px-4 py-2">
                    <Mono>{queue}</Mono>
                    <span className="flex gap-3 text-xs tabular-nums">
                      {s.paused && <span className="text-warn">pausiert</span>}
                      {s.active > 0 && <span className="text-accent">{s.active} aktiv</span>}
                      {s.queued > 0 && <span className="text-muted">{s.queued} wartend</span>}
                      {s.failed > 0 && <span className="text-danger">{s.failed} fehlgeschl.</span>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-sm text-muted">Keine Jobs in Arbeit.</p>
            )}
          </Panel>

          <Panel
            title="Budget heute"
            description="Tagesausgaben je externem Dienst. Ist ein Budget erreicht, ruft die Pipeline den Dienst bis zum nächsten Tag (UTC) nicht mehr auf."
            actions={<TextLink href="/costs" className="text-sm">Kosten</TextLink>}
          >
            <ul className="space-y-3.5">
              {data.budgets.map((b) => (
                <li key={b.service} className="space-y-1.5">
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="capitalize">{b.service}</span>
                    <span className="text-xs text-muted tabular-nums">
                      {fmt.eur(b.spentEur)} / {fmt.eur(b.budgetEur, 0)}
                    </span>
                  </div>
                  <Meter ratio={b.ratio} label={`Budget ${b.service}`} />
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
