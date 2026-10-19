import Link from "next/link";
import type { ReactNode } from "react";
import type { RunStatus } from "@/lib/db/schema";
import type { RunView } from "@/lib/domain/runs";
import { RUN_KIND_LABELS, RUN_STATUS_LABELS, SCOPE_TYPE_LABELS } from "./labels";
import { Badge, EmptyState, fmt, Mono, numClass, Table, tdClass, thClass, trClass, type Tone } from "./ui";

export const RUN_STATUS_TONES: Record<RunStatus, Tone> = {
  queued: "neutral",
  running: "accent",
  finished: "ok",
  failed: "danger",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <Badge tone={RUN_STATUS_TONES[status]}>{RUN_STATUS_LABELS[status]}</Badge>;
}

const duration = (run: RunView, now: Date) => {
  if (!run.startedAt) return "–";
  const end = run.finishedAt ?? (run.status === "running" ? now : null);
  return end ? fmt.duration(Math.max(0, Math.round((end.getTime() - run.startedAt.getTime()) / 1000))) : "–";
};

export function RunsTable({ runs, empty }: { runs: RunView[]; empty?: ReactNode }) {
  if (runs.length === 0)
    return (
      <EmptyState title="Noch keine Läufe">
        {empty ?? "Läufe entstehen, wenn eine Verarbeitung gestartet wird oder der Zeitplan sie anstößt."}
      </EmptyState>
    );
  const now = new Date();
  return (
    <Table>
      <thead>
        <tr>
          <th className={thClass}>Lauf</th>
          <th className={thClass}>Bereich</th>
          <th className={thClass}>Status</th>
          <th className={thClass}>Gestartet</th>
          <th className={`${thClass} text-right`}>Dauer</th>
          <th className={`${thClass} text-right`}>Kosten</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id} className={trClass}>
            <td className={tdClass}>
              <Link href={`/runs/${run.id}`} className="font-medium text-accent hover:underline">
                {RUN_KIND_LABELS[run.kind]}
              </Link>{" "}
              <Mono title={run.id}>{run.id.slice(0, 8)}</Mono>
              <div className="text-xs text-muted">von {run.triggeredBy}</div>
            </td>
            <td className={tdClass}>{SCOPE_TYPE_LABELS[run.scope.type]}</td>
            <td className={tdClass}>
              <RunStatusBadge status={run.status} />
            </td>
            <td className={`${tdClass} whitespace-nowrap`} title={fmt.dateTime(run.startedAt)}>
              {fmt.ago(run.startedAt, now)}
            </td>
            <td className={`${tdClass} ${numClass}`}>{duration(run, now)}</td>
            <td className={`${tdClass} ${numClass}`}>{fmt.eur(run.costEur, run.costEur > 0 && run.costEur < 0.01 ? 4 : 2)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
