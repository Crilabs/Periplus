import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getDb } from "@/lib/db/client";
import { budgetStatus, spendBreakdown, spendByService, type SpendBreakdownRow } from "@/lib/domain/costs";
import { requireAdmin } from "@/lib/security/require-admin";
import {
  cx,
  EmptyState,
  fmt,
  Meter,
  Mono,
  numClass,
  PageHeader,
  Panel,
  Stat,
  Table,
  tdClass,
  TextLink,
  thClass,
  trClass,
} from "../_components/ui";

export const metadata: Metadata = { title: "Kosten" };

/** Small amounts keep four decimals so cent fractions of single model calls stay visible. */
const eur = (n: number) => fmt.eur(n, n > 0 && n < 0.01 ? 4 : 2);

function BreakdownTable({
  title,
  description,
  keyLabel,
  rows,
  renderKey,
  className,
}: {
  title: string;
  description: string;
  keyLabel: string;
  rows: SpendBreakdownRow[];
  renderKey?: (key: string) => ReactNode;
  className?: string;
}) {
  return (
    <Panel title={title} description={description} className={className} flush>
      {rows.length === 0 ? (
        <EmptyState title="Keine Kosten erfasst">Kosten entstehen, wenn ein Lauf einen externen Dienst aufruft.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={thClass}>{keyLabel}</th>
              <th className={`${thClass} text-right`}>Aufrufe</th>
              <th className={`${thClass} text-right`}>Kosten</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={trClass}>
                <td className={tdClass}>{renderKey ? renderKey(r.key) : <Mono>{r.key}</Mono>}</td>
                <td className={cx(tdClass, numClass)}>{fmt.int(r.calls)}</td>
                <td className={cx(tdClass, numClass)}>{eur(r.costEur)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
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
  const total30 = spend.reduce((n, s) => n + s.costEur, 0);
  const spentToday = budgets.reduce((n, b) => n + b.spentEur, 0);
  const budgetToday = budgets.reduce((n, b) => n + b.budgetEur, 0);
  const tightest = budgets.reduce((max, b) => Math.max(max, b.ratio), 0);

  return (
    <>
      <PageHeader
        title="Kosten"
        description="Was externe Dienste (Modelle, Einbettungen, Suche, Seitenabruf) kosten: heute gegen das Tagesbudget, dazu die letzten 30 Tage nach Dienst, Stufe und Lauf."
      />

      <div className="grid gap-6 xl:grid-cols-3">
        <Panel
          title="Budget heute"
          description="Tagesausgaben je externem Dienst. Ist ein Budget erreicht, ruft die Pipeline den Dienst bis zum nächsten Tag (UTC) nicht mehr auf."
        >
          <p className="mb-4 flex items-baseline justify-between gap-3">
            <span
              className={cx(
                "text-2xl font-semibold tabular-nums tracking-tight",
                tightest >= 1 ? "text-danger" : tightest >= 0.8 ? "text-warn" : "",
              )}
            >
              {fmt.eur(spentToday)}
            </span>
            <span className="text-xs text-muted">von {fmt.eur(budgetToday, 0)} gesamt</span>
          </p>
          <ul className="space-y-3.5">
            {budgets.map((b) => (
              <li key={b.service} className="space-y-1.5">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="capitalize">{b.service}</span>
                  <span className="text-xs text-muted tabular-nums">
                    {fmt.eur(b.spentEur)} / {fmt.eur(b.budgetEur, 0)} · {fmt.pct(b.ratio)}
                  </span>
                </div>
                <Meter ratio={b.ratio} label={`Budget ${b.service}`} />
              </li>
            ))}
          </ul>
        </Panel>

        <div className="space-y-3 xl:col-span-2">
          <h2 className="text-sm font-semibold">Letzte 30 Tage</h2>
          {spend.length === 0 ? (
            <Panel>
              <EmptyState title="Keine Kosten erfasst">Kosten entstehen, wenn ein Lauf einen externen Dienst aufruft.</EmptyState>
            </Panel>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Stat label="Gesamt" value={fmt.eur(total30)} hint={`Im Schnitt ${fmt.eur(total30 / 30)} pro Tag`} />
              {spend.map((s) => (
                <Stat
                  key={s.service}
                  label={<span className="capitalize">{s.service}</span>}
                  value={eur(s.costEur)}
                  hint={total30 > 0 ? `${fmt.pct(s.costEur / total30)} der Kosten` : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <BreakdownTable
          title="Kosten nach Stufe (30 Tage)"
          description="Teuerste Stufe zuerst. Aufrufe ohne Stufe fehlen hier."
          keyLabel="Stufe"
          rows={byStage}
        />
        <BreakdownTable
          title="Kosten nach Monat (365 Tage)"
          description="Kalendermonate in UTC, neuester zuerst."
          keyLabel="Monat"
          rows={byMonth}
        />
        <BreakdownTable
          title="Kosten nach Lauf (30 Tage)"
          description="Teuerster Lauf zuerst. Aufrufe ohne Lauf fehlen hier."
          keyLabel="Lauf"
          rows={byRun}
          className="lg:col-span-2"
          renderKey={(id) => (
            <TextLink href={`/runs/${id}`} className="font-mono text-[0.8125rem]" title={id}>
              {id.slice(0, 8)}
            </TextLink>
          )}
        />
      </div>
    </>
  );
}
