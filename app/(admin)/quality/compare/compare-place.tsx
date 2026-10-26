"use client";

import { useState, useTransition } from "react";
import type { ComparisonAttribute } from "@/lib/domain/quality/comparison-values";
import { Badge, Button, cx, Notice, Panel, Table, tdClass, thClass, trClass } from "../../_components/ui";
import { acceptProposalsAction, recordComparisonAction, type AcceptProposalsResult } from "./actions";

type Outcome = "match" | "deviation" | "not_at_navily";

/** One compared attribute as the page shows it; every text is prepared on the server at request time. */
export type CompareRow = {
  attribute: ComparisonAttribute;
  label: string;
  own: string;
  /** The Navily side at request time (never stored); null without a Navily file. */
  navily: string | null;
  proposal: Outcome | null;
  stored: { label: string; detail: string; carried: boolean; tone: "ok" | "warn" | "neutral" } | null;
  valueHash: string;
};

const OUTCOME_BUTTONS: Array<[Outcome, string]> = [
  ["match", "stimmt"],
  ["deviation", "weicht ab"],
  ["not_at_navily", "bei Navily nicht vorhanden"],
];

const PROPOSAL_TONE: Record<Outcome, "ok" | "warn" | "neutral"> = { match: "ok", deviation: "warn", not_at_navily: "neutral" };

/** German notices for the failure codes of the actions. */
const FAILURES: Record<Extract<AcceptProposalsResult, { ok: false }>["code"], string> = {
  stale: "Nicht gespeichert: Der eigene Wert oder der Vorschlag hat sich inzwischen geändert. Bitte die Seite neu laden und erneut prüfen.",
  navily_missing: "Nicht gespeichert: Es ist keine Navily-Datei geladen (NAVILY_SPOTS_PATH nicht gesetzt).",
  navily_unreadable: "Nicht gespeichert: Die Navily-Datei ist nicht lesbar. Details stehen im Server-Log.",
};

type ActionNotice = { notice: string } | { error: string };

/**
 * The comparison table of one place: own value, Navily at request time, proposal, stored outcome and the three
 * outcome buttons; „Alle Vorschläge übernehmen“ (with the digest of the shown proposals) when a Navily file is loaded.
 * The server recomputes values and proposals on every click; a click on a value or proposal that changed meanwhile is
 * refused (reload the page).
 */
export function ComparePlace({
  placeId,
  subdivisionKey,
  title,
  description,
  rows,
  digest,
}: {
  placeId: string;
  subdivisionKey: string;
  title: string;
  description: string;
  rows: CompareRow[];
  /** Digest of the shown proposals; null without a Navily file (then no „Alle Vorschläge übernehmen“). */
  digest: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = { placeId, subdivisionKey };

  const run = (work: () => Promise<ActionNotice | null>) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const out = await work();
        if (out && "error" in out) setError(out.error);
        else setNotice(out?.notice ?? null);
      } catch {
        setError("Nicht gespeichert: Ein unerwarteter Fehler ist aufgetreten. Bitte die Seite neu laden.");
      }
    });
  };
  const record = (row: CompareRow, result: Outcome) =>
    run(async () => {
      const r = await recordComparisonAction({ ...base, attribute: row.attribute, result, valueHash: row.valueHash });
      return r.ok ? null : { error: FAILURES[r.code] };
    });
  const acceptAll = (shown: string) =>
    run(async () => {
      const r = await acceptProposalsAction({ ...base, digest: shown });
      if (!r.ok) return { error: FAILURES[r.code] };
      const kept = r.skippedManual > 0 ? ` ${r.skippedManual} von Hand gesetzte Ergebnisse beibehalten.` : "";
      return {
        notice:
          (r.written === 0
            ? "Alle Vorschläge waren schon übernommen."
            : `${r.written} Ergebnisse gespeichert${r.tasks > 0 ? `, ${r.tasks} neue Prüfaufgaben` : ""}.`) + kept,
      };
    });

  return (
    <Panel
      title={title}
      description={description}
      flush
      actions={
        digest !== null && (
          <Button type="button" size="sm" variant="primary" disabled={pending} onClick={() => acceptAll(digest)}>
            Alle Vorschläge übernehmen
          </Button>
        )
      }
    >
      {(error || notice) && (
        <div className="border-b border-line px-4 py-3">
          <Notice tone={error ? "danger" : "ok"}>{error ?? notice}</Notice>
        </div>
      )}
      <Table>
        <thead>
          <tr>
            <th className={thClass}>Attribut</th>
            <th className={thClass}>Eigener Wert</th>
            <th className={thClass}>Navily (Laufzeit)</th>
            <th className={thClass}>Vorschlag</th>
            <th className={thClass}>Gespeichertes Ergebnis</th>
            <th className={thClass}>
              <span className="sr-only">Ergebnis setzen</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.attribute} className={trClass} data-testid={`compare-row-${row.attribute}`}>
              <td className={cx(tdClass, "font-medium whitespace-nowrap")}>{row.label}</td>
              <td className={tdClass}>{row.own}</td>
              <td className={cx(tdClass, "text-muted")}>{row.navily ?? "–"}</td>
              <td className={tdClass}>
                {row.proposal ? <Badge tone={PROPOSAL_TONE[row.proposal]}>{OUTCOME_BUTTONS.find(([o]) => o === row.proposal)![1]}</Badge> : "–"}
              </td>
              <td className={tdClass}>
                {row.stored ? (
                  <span className="flex flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={row.stored.tone}>{row.stored.label}</Badge>
                      {row.stored.carried && <Badge>übernommen</Badge>}
                    </span>
                    <span className="text-xs text-muted">{row.stored.detail}</span>
                  </span>
                ) : (
                  <span className="text-muted">offen</span>
                )}
              </td>
              <td className={tdClass}>
                <span className="flex flex-wrap justify-end gap-1">
                  {OUTCOME_BUTTONS.map(([result, label]) => (
                    <Button key={result} type="button" size="sm" disabled={pending} onClick={() => record(row, result)}>
                      {label}
                    </Button>
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}
