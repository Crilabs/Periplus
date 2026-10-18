import Link from "next/link";
import type { ReactNode } from "react";
import { getDb } from "@/lib/db/client";
import { budgetStatus, spendBreakdown, spendByService, type SpendBreakdownRow } from "@/lib/domain/costs";
import { requireAdmin } from "@/lib/security/require-admin";

const eur = (n: number) => `${n.toFixed(2)} €`;

function BreakdownTable({ title, keyLabel, rows, renderKey }: {
  title: string;
  keyLabel: string;
  rows: SpendBreakdownRow[];
  renderKey?: (key: string) => ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-1 font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p>Keine Kosten erfasst.</p>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-neutral-300">
              <th className="py-1 pr-4">{keyLabel}</th>
              <th className="pr-4 text-right">Aufrufe</th>
              <th className="text-right">Kosten</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-neutral-200">
                <td className="py-1 pr-4">{renderKey ? renderKey(r.key) : r.key}</td>
                <td className="pr-4 text-right">{r.calls}</td>
                <td className="text-right">{eur(r.costEur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default async function Page() {
  await requireAdmin();
  const db = getDb();
  const [budgets, spend, byStage, byRun, byMonth] = await Promise.all([
    budgetStatus(db),
    spendByService(db, 30),
    spendBreakdown(db, "stage", { days: 30 }),
    spendBreakdown(db, "run", { days: 30 }),
    spendBreakdown(db, "month", { days: 365 }),
  ]);
  return (
    <div className="space-y-6 text-sm">
      <h1 className="text-lg font-semibold">Kosten</h1>
      <section>
        <h2 className="mb-1 font-semibold">Kosten heute</h2>
        <ul>
          {budgets.map((b) => (
            <li key={b.service}>
              {b.service}: {eur(b.spentEur)} von {eur(b.budgetEur)} Budget ({Math.round(b.ratio * 100)} %)
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="mb-1 font-semibold">Kosten je Dienst (30 Tage)</h2>
        {spend.length === 0 ? (
          <p>Keine Kosten erfasst.</p>
        ) : (
          <ul>
            {spend.map((s) => (
              <li key={s.service}>
                {s.service}: {eur(s.costEur)}
              </li>
            ))}
          </ul>
        )}
      </section>
      <BreakdownTable title="Kosten nach Stufe (30 Tage)" keyLabel="Stufe" rows={byStage} />
      <BreakdownTable
        title="Kosten nach Lauf (30 Tage)"
        keyLabel="Lauf"
        rows={byRun}
        renderKey={(id) => (
          <Link href={`/runs/${id}`} className="underline">
            {id.slice(0, 8)}
          </Link>
        )}
      />
      <BreakdownTable title="Kosten nach Monat (365 Tage)" keyLabel="Monat" rows={byMonth} />
    </div>
  );
}
