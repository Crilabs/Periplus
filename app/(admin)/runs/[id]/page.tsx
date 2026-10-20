import { notFound } from "next/navigation";
import { z } from "zod";
import type { RunStageStatus } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { consolidationBlocked } from "@/lib/domain/consolidation/targets";
import { extractionRunsOfRun, type ExtractionRunRow } from "@/lib/domain/extraction/run-view";
import { failedJobsOfRun } from "@/lib/domain/jobs-view";
import { getRun, type RunStageView, type RunView } from "@/lib/domain/runs";
import { QUEUES } from "@/lib/jobs/queues";
import { CONSOLIDATION_GEO_STAGE } from "@/lib/pipeline/consolidation/stages";
import { requireAdmin } from "@/lib/security/require-admin";
import { AutoRefresh } from "../../_components/auto-refresh";
import { Dialog } from "../../_components/dialog";
import {
  CONSOLIDATION_SKIP_REASON_LABELS,
  EXTRACTION_BLOCK_REASON_LABELS,
  EXTRACTION_PURPOSE_LABELS,
  EXTRACTION_RUN_STATUS_LABELS,
  QUOTE_FAILURE_LABELS,
  RUN_KIND_LABELS,
  RUN_NOTICE_LABELS,
  SCOPE_TYPE_LABELS,
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
  numClass,
  PageHeader,
  Panel,
  Stat,
  Table,
  tdClass,
  thClass,
  TextLink,
  trClass,
  type Tone,
} from "../../_components/ui";
import { catchUpConsolidationAction, endRunAction, recheckExtractionRunAction, retryJobAction } from "./actions";

const isRetryable = (queue: string) => (QUEUES as readonly string[]).includes(queue);

const STAGE_STATUS_TONES: Record<RunStageStatus, Tone> = { pending: "neutral", running: "accent", finished: "ok" };

const EXTRACTION_STATUS_TONES: Record<ExtractionRunRow["status"], Tone> = {
  running: "accent",
  finished: "ok",
  blocked: "danger",
  failed: "danger",
};

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

export default async function Page({ params, searchParams }: PageProps<"/runs/[id]">) {
  await requireAdmin();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const db = getDb();
  const [run, failedJobs, extractionRuns] = await Promise.all([
    getRun(db, id.data),
    failedJobsOfRun(db, id.data),
    extractionRunsOfRun(db, id.data),
  ]);
  if (!run) notFound();
  const { notice } = await searchParams;
  const noticeText = typeof notice === "string" && Object.hasOwn(RUN_NOTICE_LABELS, notice) ? RUN_NOTICE_LABELS[notice] : null;
  const skip = run.consolidationSkip;
  // While the run is still extracting its extraction runs are open, which is no block yet; a stored skip is one.
  const settled = skip !== null || (run.status !== "queued" && run.status !== "running");
  const blocked = settled && run.stages.some((s) => s.stage === CONSOLIDATION_GEO_STAGE) && (await consolidationBlocked(db, run.id));
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
                  extractionRuns.length > 0 && {
                    label: "Extraktionsläufe",
                    value: (
                      <ul className="space-y-0.5">
                        {extractionRuns.map((r) => (
                          <li key={r.id}>
                            <Mono>{r.id}</Mono>
                          </li>
                        ))}
                      </ul>
                    ),
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
        {blocked && (
          <Notice tone="danger" title="Konsolidierung gesperrt: Belegtreue unter 100 %">
            Nicht jedes Zitat eines Extraktionslaufs wurde im Text gefunden, oder ein Extraktionslauf ist noch nicht
            geprüft. Bis dahin konsolidiert dieser Lauf nichts. Unter „Extraktionsläufe“ die Belegtreue
            neu prüfen.
          </Notice>
        )}
        {noticeText && <Notice tone="warn">{noticeText}</Notice>}
        {run.failureReason && (
          <Notice tone="danger" title="Lauf fehlgeschlagen">
            <span className="break-words">{run.failureReason}</span>
          </Notice>
        )}
        {skip && (
          <Notice
            tone="warn"
            title={`Konsolidierung übersprungen: ${CONSOLIDATION_SKIP_REASON_LABELS[skip.reason]}`}
            actions={
              !skip.catchUpRunId && (
                <form action={catchUpConsolidationAction}>
                  <input type="hidden" name="runId" value={run.id} />
                  <Button type="submit" size="sm">
                    Konsolidierung nachholen
                  </Button>
                </form>
              )
            }
          >
            <span title={fmt.dateTime(new Date(skip.at))}>Am {fmt.dateTime(new Date(skip.at))}.</span>{" "}
            {skip.catchUpRunId && (
              <>
                Nachgeholt in{" "}
                <TextLink href={`/runs/${skip.catchUpRunId}`}>Lauf {skip.catchUpRunId.slice(0, 8)}</TextLink>.
              </>
            )}
          </Notice>
        )}
      </div>

      <div className={cx("grid gap-3 sm:grid-cols-2 xl:grid-cols-4", (blocked || noticeText || run.failureReason || skip) && "mt-6")}>
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

      {extractionRuns.length > 0 && <ExtractionRuns rows={extractionRuns} />}

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

const pct = (ratio: number) => `${(ratio * 100).toLocaleString("de-DE", { maximumFractionDigits: 4 })} %`;
const count = (n: number | null) => (n === null ? "–" : fmt.int(n));

/** One row per extraction run: model, purpose, facts, rejected quotes, Belegtreue and status (blocked in red). */
function ExtractionRuns({ rows }: { rows: ExtractionRunRow[] }) {
  return (
    <Panel
      title="Extraktionsläufe"
      description="Belegtreue: Anteil der Facts, deren wörtliches Zitat im Text gefunden wurde. Unter 100 % ist der Extraktionslauf gesperrt und wird nicht konsolidiert."
      className="mt-6"
      flush
    >
      <Table>
        <thead>
          <tr>
            <th className={thClass}>Aufgabe</th>
            <th className={thClass}>Modell</th>
            <th className={thClass}>Zweck</th>
            <th className={`${thClass} text-right`}>Facts</th>
            <th className={`${thClass} text-right`} title="Facts, deren Zitat schon beim Empfang nicht im Text stand (nicht gespeichert)">
              Verworfene Zitate
            </th>
            <th className={`${thClass} text-right`}>Belegtreue</th>
            <th className={`${thClass} text-right`}>Kosten</th>
            <th className={thClass}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={trClass}>
              <td className={tdClass}>{r.task === "extract-route" ? "Routen" : "Facts"}</td>
              <td className={tdClass}>
                <Mono>{r.model}</Mono>
                <div className="text-xs text-muted">
                  Prompt v{r.promptVersion}, Schema {r.factSchemaVersion}
                </div>
              </td>
              <td className={tdClass}>{EXTRACTION_PURPOSE_LABELS[r.purpose]}</td>
              <td className={cx(tdClass, numClass)}>
                {count(r.items)}
                {r.task === "extract-route" && r.items !== null ? " Stopps" : ""}
              </td>
              <td className={cx(tdClass, numClass)}>{count(r.rejectedQuotes)}</td>
              <td className={cx(tdClass, numClass)}>
                {r.quoteCheck ? (
                  <>
                    <span className={r.quoteCheck.verified < r.quoteCheck.facts ? "text-danger" : undefined}>
                      {pct(r.quoteCheck.ratio)}
                    </span>{" "}
                    <span className="text-xs text-muted">
                      ({r.quoteCheck.verified}/{r.quoteCheck.facts})
                    </span>
                    {r.quoteCheck.failures.length > 0 && (
                      <span className="block text-xs whitespace-normal text-danger">
                        {r.quoteCheck.failures
                          .slice(0, 3)
                          .map((f) => QUOTE_FAILURE_LABELS[f.reason] ?? f.reason)
                          .join(", ")}
                        {r.quoteCheck.failures.length > 3 ? ` … (${r.quoteCheck.failures.length})` : ""}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-muted">noch nicht geprüft</span>
                )}
              </td>
              <td className={cx(tdClass, numClass)}>{r.costEur === null ? "–" : eur(r.costEur)}</td>
              <td className={tdClass}>
                <Badge tone={EXTRACTION_STATUS_TONES[r.status]}>{EXTRACTION_RUN_STATUS_LABELS[r.status]}</Badge>
                {r.blockedReason && (
                  <span className="mt-1 block max-w-56 text-xs text-muted">{EXTRACTION_BLOCK_REASON_LABELS[r.blockedReason]}</span>
                )}
                {r.status === "blocked" && (
                  <form action={recheckExtractionRunAction} className="mt-2">
                    <input type="hidden" name="extractionRunId" value={r.id} />
                    <Button type="submit" size="sm">
                      Belegtreue neu prüfen
                    </Button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

