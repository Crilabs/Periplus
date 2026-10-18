import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { overview } from "@/lib/domain/overview";
import { requireAdmin } from "@/lib/security/require-admin";
import { RunsTable } from "./_components/runs-table";

const eur = (n: number) => `${n.toFixed(2)} €`;

export default async function Page() {
  await requireAdmin();
  const data = await overview(getDb());
  const openTotal = Object.values(data.openReviewTasks).reduce((a, b) => a + b, 0);
  return (
    <div className="space-y-6 text-sm">
      <h1 className="text-lg font-semibold">Übersicht</h1>

      <section>
        <h2 className="mb-1 font-semibold">Offene Prüfungen</h2>
        <p>Gesamt: {openTotal}</p>
        <ul className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
          {Object.entries(data.openReviewTasks).map(([kind, n]) => (
            <li key={kind}>
              {kind}: {n}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Jobs</h2>
        <ul>
          {Object.entries(data.jobs).map(([queue, s]) => (
            <li key={queue}>
              {queue}: {s.queued} wartend, {s.active} aktiv, {s.failed} fehlgeschlagen{s.paused ? " (pausiert)" : ""}
            </li>
          ))}
        </ul>
        {data.workers.length === 0 ? (
          <p>Kein Worker aktiv.</p>
        ) : (
          <ul>
            {data.workers.map((w) => (
              <li key={w.workerId}>
                {w.workerId}: Worker zuletzt aktiv vor {w.beatAgeSeconds} s
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Kosten heute</h2>
        <ul>
          {data.budgets.map((b) => (
            <li key={b.service}>
              {b.service}: {eur(b.spentEur)} von {eur(b.budgetEur)} Budget ({Math.round(b.ratio * 100)} %)
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-1 font-semibold">
          <Link href="/runs" className="hover:underline">
            Läufe
          </Link>
        </h2>
        <RunsTable runs={data.recentRuns} />
      </section>
    </div>
  );
}
