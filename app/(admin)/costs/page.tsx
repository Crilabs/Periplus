import { getDb } from "@/lib/db/client";
import { budgetStatus, spendByService } from "@/lib/domain/costs";
import { requireAdmin } from "@/lib/security/require-admin";

const eur = (n: number) => `${n.toFixed(2)} €`;

export default async function Page() {
  await requireAdmin();
  const db = getDb();
  const [budgets, spend] = await Promise.all([budgetStatus(db), spendByService(db, 30)]);
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
    </div>
  );
}
