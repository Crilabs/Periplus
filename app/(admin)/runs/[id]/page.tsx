import { notFound } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { getRun } from "@/lib/domain/runs";
import { requireAdmin } from "@/lib/security/require-admin";
import { RUN_KIND_LABELS, RUN_STATUS_LABELS, SCOPE_TYPE_LABELS, STAGE_STATUS_LABELS } from "../../_components/labels";

export default async function Page({ params }: PageProps<"/runs/[id]">) {
  await requireAdmin();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const run = await getRun(getDb(), id.data);
  if (!run) notFound();
  return (
    <div className="space-y-4 text-sm">
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
    </div>
  );
}
