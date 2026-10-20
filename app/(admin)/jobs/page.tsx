import type { Metadata } from "next";
import { getDb } from "@/lib/db/client";
import { queuesView, type QueueStats } from "@/lib/domain/queues-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { AutoRefresh } from "../_components/auto-refresh";
import { Dialog } from "../_components/dialog";
import { isBudgetPause, queuePauseText, queueStateLabel } from "../_components/labels";
import {
  Badge,
  Button,
  cx,
  EmptyState,
  fmt,
  Mono,
  numClass,
  PageHeader,
  Panel,
  Stat,
  Table,
  tdClass,
  thClass,
  trClass,
} from "../_components/ui";
import { pauseQueueAction, resumeQueueAction } from "./actions";

export const metadata: Metadata = { title: "Jobs" };

type Row = [queue: string, stats: QueueStats];

const count = (n: number, tone: string) => (n > 0 ? <span className={tone}>{fmt.int(n)}</span> : <span className="text-muted">0</span>);

function QueueTable({ rows }: { rows: Row[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <th className={thClass}>Warteschlange</th>
          <th className={`${thClass} text-right`}>Wartend</th>
          <th className={`${thClass} text-right`}>Aktiv</th>
          <th className={`${thClass} text-right`}>Fehlgeschlagen</th>
          <th className={thClass}>Status</th>
          <th className={thClass}>
            <span className="sr-only">Aktion</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([queue, s]) => (
          <tr key={queue} className={trClass}>
            <td className={tdClass}>
              <Mono>{queue}</Mono>
            </td>
            <td className={cx(tdClass, numClass)}>{count(s.queued, "")}</td>
            <td className={cx(tdClass, numClass)}>{count(s.active, "font-medium text-accent")}</td>
            <td className={cx(tdClass, numClass)}>{count(s.failed, "font-medium text-danger")}</td>
            <td className={tdClass}>
              <Badge tone={s.paused ? "warn" : "ok"}>{queueStateLabel(s.paused)}</Badge>
              {s.pause && <span className="ml-2 text-xs text-muted">{queuePauseText(s.pause)}</span>}
            </td>
            <td className={cx(tdClass, "text-right")}>
              {s.pausable &&
                (isBudgetPause(s.pause) ? (
                  <Dialog
                    trigger="Fortsetzen …"
                    triggerSize="sm"
                    title="Budget-Stopp aufheben"
                    description={`${queuePauseText(s.pause!)}. Weiterlaufen lässt jeden Job erneut am Budget scheitern, bis die Queue wieder pausiert; normalerweise bis zum Ende abwarten.`}
                  >
                    <form action={resumeQueueAction} className="flex justify-end">
                      <input type="hidden" name="queue" value={queue} />
                      <Button type="submit" variant="danger">
                        Trotzdem fortsetzen
                      </Button>
                    </form>
                  </Dialog>
                ) : (
                  <form action={s.paused ? resumeQueueAction : pauseQueueAction}>
                    <input type="hidden" name="queue" value={queue} />
                    <Button type="submit" size="sm" variant={s.paused ? "primary" : "secondary"}>
                      {s.paused ? "Fortsetzen" : "Pausieren"}
                    </Button>
                  </form>
                ))}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default async function Page() {
  await requireAdmin();
  const queues = await queuesView(getDb());
  const rows = Object.entries(queues) as Row[];
  const busy = rows.filter(([, s]) => s.queued + s.active + s.failed > 0 || s.paused);
  const idle = rows.filter(([, s]) => !(s.queued + s.active + s.failed > 0 || s.paused));
  const sum = (key: "queued" | "active" | "failed") => rows.reduce((n, [, s]) => n + s[key], 0);
  const paused = rows.filter(([, s]) => s.paused).length;

  return (
    <>
      <AutoRefresh intervalMs={5000} />
      <PageHeader
        title="Jobs"
        description="Jede Stufe eines Laufs verteilt ihre Arbeit als Jobs auf Warteschlangen, die der Worker abarbeitet. Die Seite aktualisiert sich alle fünf Sekunden."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Aktiv" value={fmt.int(sum("active"))} tone={sum("active") > 0 ? "accent" : "neutral"} hint="Jobs, die der Worker gerade bearbeitet" />
        <Stat label="Wartend" value={fmt.int(sum("queued"))} hint="Jobs in der Warteschlange, auch geplante Wiederholungen" />
        <Stat
          label="Fehlgeschlagen"
          value={fmt.int(sum("failed"))}
          tone={sum("failed") > 0 ? "danger" : "neutral"}
          hint="Endgültig gescheitert; einzeln auf der Seite des Laufs erneut starten"
        />
        <Stat
          label="Pausiert"
          value={paused}
          tone={paused > 0 ? "warn" : "neutral"}
          hint={paused > 0 ? "Diese Warteschlangen nehmen keine neuen Jobs an" : "Alle Warteschlangen laufen"}
        />
      </div>

      <Panel
        title="Warteschlangen mit Jobs"
        description={
          <>
            Pausieren: Der Worker nimmt aus der Warteschlange keine neuen Jobs mehr an (er prüft das etwa alle 30 Sekunden);
            wartende Jobs bleiben liegen und laufen nach „Fortsetzen“ weiter. Ist ein Tagesbudget erreicht, pausiert die
            Pipeline die betroffenen Warteschlangen selbst bis 0:00 UTC. <Mono>system.dead</Mono> sammelt endgültig
            gescheiterte Jobs und lässt sich nicht pausieren.
          </>
        }
        className="mt-6"
        flush
      >
        {busy.length === 0 ? (
          <EmptyState title="Keine Jobs in Arbeit">
            Jobs entstehen, sobald ein Lauf startet. Läufe lassen sich unter „Läufe“ starten.
          </EmptyState>
        ) : (
          <QueueTable rows={busy} />
        )}
        {idle.length > 0 && (
          <details className="group border-t border-line">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
              <span aria-hidden className="inline-block transition-transform group-open:rotate-90">
                ›
              </span>
              {idle.length} leere Warteschlangen
            </summary>
            <div className="border-t border-line">
              <QueueTable rows={idle} />
            </div>
          </details>
        )}
      </Panel>
    </>
  );
}
