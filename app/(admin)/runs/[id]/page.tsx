import { notFound } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { failedJobsOfRun } from "@/lib/domain/jobs-view";
import { getRun } from "@/lib/domain/runs";
import { QUEUES } from "@/lib/jobs/queues";
import { requireAdmin } from "@/lib/security/require-admin";
import { AutoRefresh } from "../../_components/auto-refresh";
import { RUN_KIND_LABELS, RUN_STATUS_LABELS, SCOPE_TYPE_LABELS, STAGE_STATUS_LABELS } from "../../_components/labels";
import { retryJobAction } from "./actions";

const time = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const isRetryable = (queue: string) => (QUEUES as readonly string[]).includes(queue);

export default async function Page({ params }: PageProps<"/runs/[id]">) {
  await requireAdmin();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const db = getDb();
  const [run, failedJobs] = await Promise.all([getRun(db, id.data), failedJobsOfRun(db, id.data)]);
  if (!run) notFound();
  return (
    <div className="space-y-4 text-sm">
      <AutoRefresh intervalMs={5000} />
      <h1 className="text-lg font-semibold">Lauf {run.id}</h1>
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
        <dt>Gestartet von</dt>
        <dd>{run.triggeredBy}</dd>
        <dt>Kosten</dt>
        <dd>{run.costEur.toFixed(4)} €</dd>
      </dl>
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
