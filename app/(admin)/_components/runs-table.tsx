import Link from "next/link";
import type { RunView } from "@/lib/domain/runs";
import { RUN_KIND_LABELS, RUN_STATUS_LABELS } from "./labels";

const date = (d: Date | null) => (d ? d.toISOString().slice(0, 19).replace("T", " ") : "–");

export function RunsTable({ runs }: { runs: RunView[] }) {
  if (runs.length === 0) return <p>Keine Läufe.</p>;
  return (
    <table className="w-full text-left">
      <thead>
        <tr className="border-b border-neutral-300">
          <th className="py-1 pr-4">Lauf</th>
          <th className="pr-4">Art</th>
          <th className="pr-4">Status</th>
          <th className="pr-4">Gestartet</th>
          <th className="pr-4">Von</th>
          <th className="text-right">Kosten</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id} className="border-b border-neutral-200">
            <td className="py-1 pr-4">
              <Link href={`/runs/${run.id}`} className="underline">
                {run.id.slice(0, 8)}
              </Link>
            </td>
            <td className="pr-4">{RUN_KIND_LABELS[run.kind]}</td>
            <td className="pr-4">{RUN_STATUS_LABELS[run.status]}</td>
            <td className="pr-4">{date(run.startedAt)}</td>
            <td className="pr-4">{run.triggeredBy}</td>
            <td className="text-right">{run.costEur.toFixed(4)} €</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
