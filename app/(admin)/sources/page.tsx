import Link from "next/link";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { DOC_TYPES, sourceStatusEnum, type DocType, type SourceStatus } from "@/lib/db/schema";
import { listSources, SOURCES_PAGE_SIZE, sourceDomains, sourceStatusCounts } from "@/lib/domain/sources-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { AutoRefresh } from "../_components/auto-refresh";
import { DOC_TYPE_LABELS, RUN_STATUS_LABELS, SOURCE_STATUS_LABELS, sourcePageError } from "../_components/labels";
import {
  crawlAllApprovedAction,
  createSourceAction,
  discoveryAreaAction,
  embedBackfillAction,
  proposalRunAction,
  wikivoyageRunAction,
} from "./actions";

const BUTTON = "rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-100";
const INPUT = "rounded border border-neutral-400 px-2 py-1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const param = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const time = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "–");
const eur = (n: number) => `${n.toFixed(2)} €`;
const weight = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });

export default async function Page({ searchParams }: PageProps<"/sources">) {
  await requireAdmin();
  const sp = await searchParams;
  const statusParam = param(sp.status);
  const typeParam = param(sp.type);
  const status = sourceStatusEnum.enumValues.includes(statusParam as SourceStatus) ? (statusParam as SourceStatus) : undefined;
  const type = DOC_TYPES.includes(typeParam as DocType) ? (typeParam as DocType) : undefined;
  const q = param(sp.q)?.slice(0, 200) ?? "";
  const page = Math.max(1, Number.parseInt(param(sp.page) ?? "1", 10) || 1);
  const error = sourcePageError(sp.error);
  const startedRun = UUID.test(param(sp.run) ?? "") ? param(sp.run)! : null;
  const skippedIds = (param(sp.skipped) ?? "").split(",").filter((id) => UUID.test(id)).slice(0, 200);

  const db = getDb();
  const [counts, list, skipped] = await Promise.all([
    sourceStatusCounts(db),
    listSources(db, { status, type, q, page }),
    sourceDomains(db, skippedIds),
  ]);
  const pages = Math.max(1, Math.ceil(list.total / SOURCES_PAGE_SIZE));
  const active = list.rows.some((r) => r.lastRun && (r.lastRun.status === "queued" || r.lastRun.status === "running"));
  const areas = getConfig().areas.map((a) => ({ key: a.key, name: a.names.de ?? a.key }));
  const areaOptions = areas.map((a) => (
    <option key={a.key} value={a.key}>
      {a.name}
    </option>
  ));
  const href = (over: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, type, q: q || undefined, page: undefined, ...over })) if (v) query.set(k, v);
    const s = query.toString();
    return s ? `/sources?${s}` : "/sources";
  };

  return (
    <div className="space-y-4 text-sm">
      {active && <AutoRefresh intervalMs={5000} />}
      <h1 className="text-lg font-semibold">Quellen</h1>
      {error && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2">
          Nicht ausgeführt: {error}
        </p>
      )}
      {startedRun && (
        <p role="status" className="rounded bg-green-100 px-3 py-2">
          Lauf gestartet:{" "}
          <Link href={`/runs/${startedRun}`} className="font-mono text-xs underline">
            {startedRun.slice(0, 8)}
          </Link>
          {skipped.length > 0 && <> – übersprungen, läuft bereits: {skipped.map((s) => s.domain).join(", ")}</>}
        </p>
      )}

      <ul className="flex flex-wrap gap-3" aria-label="Quellen je Status">
        {sourceStatusEnum.enumValues.map((s) => (
          <li key={s}>
            <Link href={href({ status: s })} className={status === s ? "font-semibold underline" : "underline"}>
              {SOURCE_STATUS_LABELS[s]}: <span className="tabular-nums">{counts[s]}</span>
            </Link>
          </li>
        ))}
      </ul>

      <section className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <form action={discoveryAreaAction} className="flex items-center gap-2">
          <select name="areaKey" required aria-label="Revier für die Quellenfindung" className={INPUT}>
            {areaOptions}
          </select>
          <button type="submit" className={BUTTON}>
            Quellenfindung
          </button>
        </form>
        <form action={wikivoyageRunAction} className="flex items-center gap-2">
          <select name="areaKey" required aria-label="Revier für Wikivoyage" className={INPUT}>
            {areaOptions}
          </select>
          <button type="submit" className={BUTTON}>
            Wikivoyage
          </button>
        </form>
        <form action={proposalRunAction}>
          <button type="submit" className={BUTTON}>
            Linkgraph-Vorschläge
          </button>
        </form>
        <form action={crawlAllApprovedAction}>
          <button type="submit" className={BUTTON}>
            Alle freigegebenen crawlen
          </button>
        </form>
        <form action={embedBackfillAction}>
          <button type="submit" className={BUTTON}>
            Einbettungen nachholen
          </button>
        </form>
      </section>

      <form action={createSourceAction} className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Neue Quelle</span>
        <input name="domain" required placeholder="Domain oder URL" aria-label="Domain" className={INPUT} />
        <input name="name" required placeholder="Name" aria-label="Name" className={INPUT} />
        <select name="type" required aria-label="Typ" className={INPUT}>
          {DOC_TYPES.map((t) => (
            <option key={t} value={t}>
              {DOC_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <button type="submit" className={BUTTON}>
          Anlegen (freigegeben)
        </button>
      </form>

      <form method="get" className="flex flex-wrap items-center gap-2">
        <select name="status" defaultValue={status ?? ""} aria-label="Status" className={INPUT}>
          <option value="">Alle Status</option>
          {sourceStatusEnum.enumValues.map((s) => (
            <option key={s} value={s}>
              {SOURCE_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select name="type" defaultValue={type ?? ""} aria-label="Typ" className={INPUT}>
          <option value="">Alle Typen</option>
          {DOC_TYPES.map((t) => (
            <option key={t} value={t}>
              {DOC_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <input name="q" defaultValue={q} placeholder="Domain oder Name" aria-label="Suche" className={INPUT} />
        <button type="submit" className={BUTTON}>
          Filtern
        </button>
      </form>

      {list.rows.length === 0 ? (
        <p>Keine Quellen.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-neutral-300">
                <th className="py-1 pr-4">Domain</th>
                <th className="pr-4">Name</th>
                <th className="pr-4">Status</th>
                <th className="pr-4">Typ</th>
                <th className="pr-4">Gewicht</th>
                <th className="pr-4">Dokumente</th>
                <th className="pr-4">Versionen</th>
                <th className="pr-4">Letzter Lauf</th>
                <th>Kosten 30 Tage</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr key={r.id} className="border-b border-neutral-200">
                  <td className="py-1 pr-4">
                    <Link href={`/sources/${r.id}`} className="underline">
                      {r.domain}
                    </Link>
                  </td>
                  <td className="pr-4">{r.name}</td>
                  <td className="pr-4">{SOURCE_STATUS_LABELS[r.status]}</td>
                  <td className="pr-4">{DOC_TYPE_LABELS[r.type]}</td>
                  <td className="pr-4 tabular-nums">{weight(r.weight)}</td>
                  <td className="pr-4 tabular-nums">{r.documents}</td>
                  <td className="pr-4 tabular-nums">{r.versions}</td>
                  <td className="pr-4 whitespace-nowrap">
                    {r.lastRun ? (
                      <Link href={`/runs/${r.lastRun.id}`} className="underline">
                        {RUN_STATUS_LABELS[r.lastRun.status]} {time(r.lastRun.finishedAt)}
                      </Link>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="tabular-nums">{eur(r.costEur30d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label="Seiten" className="flex items-center gap-3">
        {page > 1 && <Link href={href({ page: String(page - 1) })}>← Zurück</Link>}
        <span>
          Seite {page} von {pages} ({list.total} Quellen)
        </span>
        {page < pages && <Link href={href({ page: String(page + 1) })}>Weiter →</Link>}
      </nav>
    </div>
  );
}
