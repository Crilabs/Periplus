import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { RunStageStatus } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { failedJobsOfRun } from "@/lib/domain/jobs-view";
import { getRun, type RunStageView, type RunView } from "@/lib/domain/runs";
import { QUEUES } from "@/lib/jobs/queues";
import { requireAdmin } from "@/lib/security/require-admin";
import { AutoRefresh } from "../../_components/auto-refresh";
import { Dialog } from "../../_components/dialog";
import {
  RUN_KIND_LABELS,
  SCOPE_TYPE_LABELS,
  STAGE_LABELS,
  STAGE_STATUS_LABELS,
} from "../../_components/labels";
import { RunStatusBadge } from "../../_components/runs-table";
import {
  Badge,
  Button,
  cx,
  DescriptionList,
  EmptyState,
  fmt,
  Mono,
  Notice,
  PageHeader,
  Panel,
  Stat,
  Table,
  tdClass,
  thClass,
  trClass,
  type Tone,
} from "../../_components/ui";
import { endRunAction, retryJobAction } from "./actions";

/** The tab title: the run's short id (UI-15). */
export async function generateMetadata({ params }: PageProps<"/runs/[id]">): Promise<Metadata> {
  return { title: `Lauf ${(await params).id.slice(0, 8)}` };
}

const isRetryable = (queue: string) => (QUEUES as readonly string[]).includes(queue);

const STAGE_STATUS_TONES: Record<RunStageStatus, Tone> = { pending: "neutral", running: "accent", finished: "ok" };

/** Small amounts keep four decimals so cent fractions of single model calls stay visible. */
const eur = (n: number) => fmt.eur(n, n > 0 && n < 0.01 ? 4 : 2);

function runDuration(run: RunView, now: Date): string {
  if (!run.startedAt) return "–";
  const end = run.finishedAt ?? (run.status === "running" ? now : null);
  return end ? fmt.duration(Math.max(0, Math.round((end.getTime() - run.startedAt.getTime()) / 1000))) : "–";
}

/** Progress of one stage; not the budget Meter, whose full bar means "over limit". */
function StageProgress({ stage }: { stage: RunStageView }) {
  const settled = stage.done + stage.failed;
  const ratio = stage.total > 0 ? Math.min(1, settled / stage.total) : stage.status === "finished" ? 1 : 0;
  const failedRatio = stage.total > 0 ? Math.min(ratio, stage.failed / stage.total) : 0;
  return (
    <div
      role="progressbar"
      aria-label={`Fortschritt ${stage.stage}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-sunken"
    >
      <div
        className={cx("h-full", stage.status === "finished" ? "bg-ok" : "bg-accent")}
        style={{ width: `${(ratio - failedRatio) * 100}%` }}
      />
      <div className="h-full bg-danger" style={{ width: `${failedRatio * 100}%` }} />
    </div>
  );
}

export default async function Page({ params }: PageProps<"/runs/[id]">) {
  await requireAdmin();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const db = getDb();
  const [run, failedJobs] = await Promise.all([getRun(db, id.data), failedJobsOfRun(db, id.data)]);
  if (!run) notFound();
  const open = run.status === "queued" || run.status === "running";
  const now = new Date();
  const totals = run.stages.reduce(
    (t, s) => ({ done: t.done + s.done, failed: t.failed + s.failed, total: t.total + s.total }),
    { done: 0, failed: 0, total: 0 },
  );
  const finishedStages = run.stages.filter((s) => s.status === "finished").length;

  return (
    <>
      <AutoRefresh intervalMs={5000} />
      <PageHeader
        back={{ href: "/runs", label: "Läufe" }}
        title={
          <>
            Lauf <span className="font-mono">{run.id.slice(0, 8)}</span>
          </>
        }
        meta={
          <>
            <RunStatusBadge status={run.status} />
            <span>{RUN_KIND_LABELS[run.kind]}</span>
            <span aria-hidden>·</span>
            <span>
              {SCOPE_TYPE_LABELS[run.scope.type]} <Mono>{run.scope.id}</Mono>
            </span>
          </>
        }
        actions={
          <>
            <Dialog trigger="Technische Details" title="Technische Details" description="Kennungen dieses Laufs für Logs und Datenbankabfragen." wide>
              <DescriptionList
                columns={1}
                items={[
                  { label: "Lauf-ID", value: <Mono>{run.id}</Mono> },
                  { label: "Bereich", value: <Mono>{`${run.scope.type}:${run.scope.id}`}</Mono> },
                  { label: "Art", value: <Mono>{run.kind}</Mono> },
                  {
                    label: "Stufen",
                    value: <Mono>{run.stages.map((s) => s.stage).join(" → ") || "–"}</Mono>,
                  },
                  failedJobs.length > 0 && {
                    label: "Fehlgeschlagene Jobs",
                    value: (
                      <ul className="space-y-0.5">
                        {failedJobs.map((j) => (
                          <li key={j.id}>
                            <Mono>
                              {j.queue} {j.id}
                            </Mono>
                          </li>
                        ))}
                      </ul>
                    ),
                  },
                ]}
              />
            </Dialog>
            {open && (
              <Dialog
                trigger="Lauf beenden …"
                triggerVariant="danger"
                title="Lauf beenden"
                description="Für einen hängenden Lauf: beendet ihn als fehlgeschlagen und bricht seine wartenden Jobs ab. Offene Seiten nimmt der nächste Lauf mit."
              >
                <form action={endRunAction} className="flex justify-end">
                  <input type="hidden" name="runId" value={run.id} />
                  <Button type="submit" variant="danger">
                    Lauf beenden
                  </Button>
                </form>
              </Dialog>
            )}
            {run.endCleanupPending && (
              <Dialog
                trigger="Aufräumen wiederholen …"
                triggerVariant="danger"
                title="Aufräumen wiederholen"
                description="Das Beenden dieses Laufs wurde nicht vollständig abgeschlossen. Bricht seine wartenden Jobs ab, beendet ungesendete Batches, schließt offene Extraktionseinheiten und sperrt ungeprüfte Extraktionsläufe."
              >
                <form action={endRunAction} className="flex justify-end">
                  <input type="hidden" name="runId" value={run.id} />
                  <Button type="submit" variant="danger">
                    Aufräumen wiederholen
                  </Button>
                </form>
              </Dialog>
            )}
          </>
        }
      />

      <div className="space-y-3">
        {run.failureReason && (
          <Notice tone="danger" title="Lauf fehlgeschlagen">
            <span className="break-words">{run.failureReason}</span>
          </Notice>
        )}
      </div>

      <div className={cx("grid gap-3 sm:grid-cols-2 xl:grid-cols-4", run.failureReason && "mt-6")}>
        <Stat
          label="Fortschritt"
          value={`${finishedStages} / ${run.stages.length}`}
          hint={`Stufen abgeschlossen · ${fmt.int(totals.done)} von ${fmt.int(totals.total)} Jobs erledigt`}
        />
        <Stat
          label="Fehlgeschlagene Jobs"
          value={fmt.int(totals.failed)}
          tone={totals.failed > 0 ? "danger" : "neutral"}
          hint={totals.failed > 0 ? "Unten einzeln erneut starten" : "Keine Fehler"}
        />
        <Stat
          label="Dauer"
          value={runDuration(run, now)}
          hint={run.startedAt ? `Gestartet ${fmt.ago(run.startedAt, now)}` : "Noch nicht gestartet"}
        />
        <Stat label="Kosten" value={eur(run.costEur)} hint="Externe Aufrufe dieses Laufs" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Panel
          title="Stufen"
          description="Jede Stufe plant ihre Jobs, wenn die vorige abgeschlossen ist. Rot: fehlgeschlagene Jobs."
          className="xl:col-span-2"
          flush
        >
          {run.stages.length === 0 ? (
            <EmptyState title="Keine Stufen" />
          ) : (
            <ol className="divide-y divide-line">
              {run.stages.map((s) => (
                <li key={s.stage} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2">
                      <span className="w-5 text-xs text-muted tabular-nums">{s.ordinal + 1}.</span>
                      <Mono>{s.stage}</Mono>
                      {STAGE_LABELS[s.stage] && <span className="text-muted">{STAGE_LABELS[s.stage]}</span>}
                      <Badge tone={STAGE_STATUS_TONES[s.status]}>{STAGE_STATUS_LABELS[s.status]}</Badge>
                    </span>
                    <span className="text-xs text-muted tabular-nums">
                      {fmt.int(s.done)} von {fmt.int(s.total)} erledigt
                      {s.failed > 0 && <span className="text-danger"> · {fmt.int(s.failed)} fehlgeschlagen</span>}
                    </span>
                  </div>
                  <StageProgress stage={s} />
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel title="Eckdaten">
          <DescriptionList
            columns={1}
            items={[
              { label: "Art", value: RUN_KIND_LABELS[run.kind] },
              {
                label: "Bereich",
                value: (
                  <>
                    {SCOPE_TYPE_LABELS[run.scope.type]} <Mono>{run.scope.id}</Mono>
                  </>
                ),
              },
              { label: "Gestartet von", value: run.triggeredBy },
              { label: "Gestartet", value: fmt.dateTime(run.startedAt) },
              run.finishedAt && { label: "Beendet", value: fmt.dateTime(run.finishedAt) },
              run.endedBy && run.endedAt
                ? { label: "Von Hand beendet", value: `${run.endedBy}, ${fmt.dateTime(run.endedAt)}` }
                : null,
            ]}
          />
        </Panel>
      </div>

      <Panel
        title="Fehlgeschlagene Jobs"
        description="Jobs, die nach allen automatischen Wiederholungen gescheitert sind. „Erneut“ stellt einen Job wieder in die Warteschlange."
        className="mt-6"
        flush
      >
        {failedJobs.length === 0 ? (
          <EmptyState title="Keine fehlgeschlagenen Jobs" />
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={thClass}>Warteschlange</th>
                <th className={thClass}>Schlüssel</th>
                <th className={thClass}>Fehler</th>
                <th className={thClass}>Zeit</th>
                <th className={thClass}>
                  <span className="sr-only">Aktion</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {failedJobs.map((job) => (
                <tr key={job.id} className={trClass}>
                  <td className={tdClass}>
                    <Mono>{job.queue}</Mono>
                  </td>
                  <td className={cx(tdClass, "max-w-48 break-all")}>
                    <Mono>{job.key}</Mono>
                  </td>
                  <td className={cx(tdClass, "min-w-64")}>
                    <span className="line-clamp-3 break-words text-danger" title={job.error}>
                      {job.error}
                    </span>
                  </td>
                  <td className={cx(tdClass, "whitespace-nowrap")} title={fmt.dateTime(job.failedAt)}>
                    {fmt.ago(job.failedAt, now)}
                  </td>
                  <td className={cx(tdClass, "text-right")}>
                    {isRetryable(job.queue) && (
                      <form action={retryJobAction}>
                        <input type="hidden" name="queue" value={job.queue} />
                        <input type="hidden" name="jobId" value={job.id} />
                        <Button type="submit" size="sm">
                          Erneut
                        </Button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
