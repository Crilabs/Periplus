import { notFound } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { consolidationBlocked } from "@/lib/domain/consolidation/targets";
import { extractionRunsOfRun, type ExtractionRunRow } from "@/lib/domain/extraction/run-view";
import { failedJobsOfRun } from "@/lib/domain/jobs-view";
import { getRun } from "@/lib/domain/runs";
import { QUEUES } from "@/lib/jobs/queues";
import { CONSOLIDATION_GEO_STAGE } from "@/lib/pipeline/consolidation/stages";
import { requireAdmin } from "@/lib/security/require-admin";
import { AutoRefresh } from "../../_components/auto-refresh";
import {
  EXTRACTION_BLOCK_REASON_LABELS,
  EXTRACTION_PURPOSE_LABELS,
  EXTRACTION_RUN_STATUS_LABELS,
  QUOTE_FAILURE_LABELS,
  RUN_KIND_LABELS,
  RUN_STATUS_LABELS,
  SCOPE_TYPE_LABELS,
  STAGE_STATUS_LABELS,
} from "../../_components/labels";
import { endRunAction, recheckExtractionRunAction, retryJobAction } from "./actions";

const time = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const isRetryable = (queue: string) => (QUEUES as readonly string[]).includes(queue);

export default async function Page({ params }: PageProps<"/runs/[id]">) {
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
  const blocked = run.stages.some((s) => s.stage === CONSOLIDATION_GEO_STAGE) && (await consolidationBlocked(db, run.id));
  return (
    <div className="space-y-4 text-sm">
      <AutoRefresh intervalMs={5000} />
      <h1 className="text-lg font-semibold">Lauf {run.id}</h1>
      {blocked && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2 font-semibold text-red-800">
          Konsolidierung gesperrt: Belegtreue unter 100 %
        </p>
      )}
      <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
        <dt>Art</dt>
        <dd>{RUN_KIND_LABELS[run.kind]}</dd>
        <dt>Umfang</dt>
        <dd>
          {SCOPE_TYPE_LABELS[run.scope.type]}: {run.scope.id}
        </dd>
        <dt>Status</dt>
        <dd>{RUN_STATUS_LABELS[run.status]}</dd>
        {run.failureReason && (
          <>
            <dt>Fehlergrund</dt>
            <dd>{run.failureReason}</dd>
          </>
        )}
        {run.endedBy && run.endedAt && (
          <>
            <dt>Beendet von</dt>
            <dd>
              {run.endedBy} am {time(run.endedAt)}
            </dd>
          </>
        )}
        <dt>Gestartet von</dt>
        <dd>{run.triggeredBy}</dd>
        <dt>Kosten</dt>
        <dd>{run.costEur.toFixed(4)} €</dd>
      </dl>
      {(run.status === "queued" || run.status === "running") && (
        <form action={endRunAction}>
          <input type="hidden" name="runId" value={run.id} />
          <button type="submit" className="rounded border border-red-700 px-2 py-1 text-red-700">
            Lauf beenden
          </button>
          <p className="mt-1 text-xs text-neutral-600">
            Für einen hängenden Lauf: beendet ihn als fehlgeschlagen und bricht seine wartenden Jobs ab. Offene Seiten
            nimmt der nächste Lauf mit.
          </p>
        </form>
      )}
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-neutral-300">
            <th className="py-1 pr-4">Stufe</th>
            <th className="pr-4">Status</th>
            <th className="pr-4">Erledigt</th>
            <th className="pr-4">Fehlgeschlagen</th>
            <th>Gesamt</th>
          </tr>
        </thead>
        <tbody>
          {run.stages.map((s) => (
            <tr key={s.stage} className="border-b border-neutral-200">
              <td className="py-1 pr-4">{s.stage}</td>
              <td className="pr-4">{STAGE_STATUS_LABELS[s.status]}</td>
              <td className="pr-4">{s.done}</td>
              <td className="pr-4">{s.failed}</td>
              <td>{s.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {extractionRuns.length > 0 && <ExtractionRuns rows={extractionRuns} />}
      <section>
        <h2 className="mb-1 font-semibold">Fehlgeschlagene Jobs</h2>
        {failedJobs.length === 0 ? (
          <p>Keine fehlgeschlagenen Jobs.</p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-neutral-300">
                <th className="py-1 pr-4">Queue</th>
                <th className="pr-4">Schlüssel</th>
                <th className="pr-4">Fehler</th>
                <th className="pr-4">Zeit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {failedJobs.map((job) => (
                <tr key={job.id} className="border-b border-neutral-200 align-top">
                  <td className="py-1 pr-4">{job.queue}</td>
                  <td className="pr-4">{job.key}</td>
                  <td className="pr-4 break-all">{job.error}</td>
                  <td className="pr-4 whitespace-nowrap">{time(job.failedAt)}</td>
                  <td>
                    {isRetryable(job.queue) && (
                      <form action={retryJobAction}>
                        <input type="hidden" name="queue" value={job.queue} />
                        <input type="hidden" name="jobId" value={job.id} />
                        <button type="submit" className="underline">
                          Erneut
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const pct = (ratio: number) => `${(ratio * 100).toLocaleString("de-DE", { maximumFractionDigits: 4 })} %`;
const count = (n: number | null) => (n === null ? "–" : String(n));

/** One row per extraction run: model, purpose, facts, rejected quotes, Belegtreue and status (blocked in red). */
function ExtractionRuns({ rows }: { rows: ExtractionRunRow[] }) {
  return (
    <section>
      <h2 className="mb-1 font-semibold">Extraktionsläufe</h2>
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-neutral-300">
            <th className="py-1 pr-4">Aufgabe</th>
            <th className="pr-4">Modell</th>
            <th className="pr-4">Zweck</th>
            <th className="pr-4">Facts</th>
            <th className="pr-4">Verworfene Zitate</th>
            <th className="pr-4">Belegtreue</th>
            <th className="pr-4">Kosten</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-neutral-200 align-top">
              <td className="py-1 pr-4">{r.task === "extract-route" ? "Routen" : "Facts"}</td>
              <td className="pr-4">
                {r.model} <span className="text-neutral-500">(Prompt v{r.promptVersion}, Schema {r.factSchemaVersion})</span>
              </td>
              <td className="pr-4">{EXTRACTION_PURPOSE_LABELS[r.purpose]}</td>
              <td className="pr-4 tabular-nums">
                {count(r.items)}
                {r.task === "extract-route" && r.items !== null ? " Stopps" : ""}
              </td>
              <td className="pr-4 tabular-nums">{count(r.rejectedQuotes)}</td>
              <td className="pr-4 tabular-nums">
                {r.quoteCheck ? (
                  <>
                    {pct(r.quoteCheck.ratio)} ({r.quoteCheck.verified}/{r.quoteCheck.facts})
                    {r.quoteCheck.failures.length > 0 && (
                      <span className="block text-xs text-red-700">
                        {r.quoteCheck.failures
                          .slice(0, 3)
                          .map((f) => QUOTE_FAILURE_LABELS[f.reason] ?? f.reason)
                          .join(", ")}
                        {r.quoteCheck.failures.length > 3 ? ` … (${r.quoteCheck.failures.length})` : ""}
                      </span>
                    )}
                  </>
                ) : (
                  "noch nicht geprüft"
                )}
              </td>
              <td className="pr-4 tabular-nums">{r.costEur === null ? "–" : `${r.costEur.toFixed(4)} €`}</td>
              <td className={r.status === "blocked" ? "font-semibold text-red-700" : undefined}>
                {EXTRACTION_RUN_STATUS_LABELS[r.status]}
                {r.blockedReason && <span className="block text-xs font-normal">{EXTRACTION_BLOCK_REASON_LABELS[r.blockedReason]}</span>}
                {r.status === "blocked" && (
                  <form action={recheckExtractionRunAction} className="mt-1">
                    <input type="hidden" name="extractionRunId" value={r.id} />
                    <button type="submit" className="rounded border border-red-700 px-2 py-0.5 text-xs font-normal text-red-700">
                      Belegtreue neu prüfen
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
