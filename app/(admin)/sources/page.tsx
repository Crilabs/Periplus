import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getDb } from "@/lib/db/client";
import { DOC_TYPES, sourceStatusEnum, type DocType, type SourceStatus } from "@/lib/db/schema";
import { listSubdivisionOptions } from "@/lib/domain/subdivisions/store";
import { listSources, SOURCES_PAGE_SIZE, sourceDomains, sourceStatusCounts } from "@/lib/domain/sources-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { AutoRefresh } from "../_components/auto-refresh";
import { Dialog } from "../_components/dialog";
import { DOC_TYPE_LABELS, SOURCE_STATUS_LABELS, sourcePageError } from "../_components/labels";
import { RunStatusBadge } from "../_components/runs-table";
import { SubdivisionOptions } from "../_components/subdivision-options";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  FilterChips,
  fmt,
  inputClass,
  Mono,
  Notice,
  numClass,
  PageHeader,
  Pagination,
  Panel,
  Table,
  tdClass,
  thClass,
  trClass,
} from "../_components/ui";
import {
  crawlAllApprovedAction,
  createSourceAction,
  discoveryAreaAction,
  embedBackfillAction,
  pendingTextRunAction,
  proposalRunAction,
  wikivoyageRunAction,
} from "./actions";
import { SOURCE_STATUS_TONES } from "./tones";

export const metadata: Metadata = { title: "Quellen" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const param = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const weight = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });

/** One option of the "Lauf starten …" dialog: what it does on the left, the form that starts it on the right. */
function RunOption({ children, form }: { children: ReactNode; form: ReactNode }) {
  return (
    <li className="grid gap-3 py-3.5 first:pt-0 last:pb-0 sm:grid-cols-[1fr_auto] sm:items-center">
      <p className="leading-relaxed text-muted text-pretty">{children}</p>
      {form}
    </li>
  );
}

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
  const subdivisionOptions = <SubdivisionOptions options={await listSubdivisionOptions(db)} />;
  const href = (over: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, type, q: q || undefined, page: undefined, ...over })) if (v) query.set(k, v);
    const s = query.toString();
    return s ? `/sources?${s}` : "/sources";
  };
  const allCount = sourceStatusEnum.enumValues.reduce((n, s) => n + counts[s], 0);
  const filtered = Boolean(status || type || q);
  const now = new Date();

  const runDialog = (
    <Dialog
      trigger="Lauf starten …"
      title="Lauf starten"
      description="Läufe arbeiten im Hintergrund. Nach dem Start erscheint hier ein Link zum Lauf; Fortschritt und Kosten stehen unter Läufe."
      wide
    >
      <ul className="divide-y divide-line">
        <RunOption
          form={
            <form action={discoveryAreaAction} className="flex flex-wrap items-center gap-2">
              <select name="subdivisionKey" required aria-label="Landesteil für die Quellenfindung" className={inputClass}>
                {subdivisionOptions}
              </select>
              <Button>Quellenfindung</Button>
            </form>
          }
        >
          <span className="font-medium text-ink">Quellenfindung:</span> stellt die Suchanfragen des Landesteils und
          seiner Küstenkacheln (Treffer der letzten 30 Tage werden wiederverwendet) und macht aus den Treffern
          Quellenvorschläge zur Prüfung. Neue Suchanfragen kosten Geld.
        </RunOption>
        <RunOption
          form={
            <form action={wikivoyageRunAction} className="flex flex-wrap items-center gap-2">
              <select name="subdivisionKey" required aria-label="Landesteil für Wikivoyage" className={inputClass}>
                {subdivisionOptions}
              </select>
              <Button>Wikivoyage</Button>
            </form>
          }
        >
          <span className="font-medium text-ink">Wikivoyage:</span> legt fehlende Whitelist-Quellen an und ruft die
          Wikivoyage-Artikel des Landesteils ab wie jede andere Quelle. Abgelehnt, wenn die Wikivoyage-Quelle nicht
          freigegeben ist oder gerade abgerufen wird.
        </RunOption>
        <RunOption
          form={
            <form action={proposalRunAction}>
              <Button>Linkgraph-Vorschläge</Button>
            </form>
          }
        >
          <span className="font-medium text-ink">Linkgraph-Vorschläge:</span> nur der Vorschlagsschritt, ohne neue
          Suche. Macht aus vorhandenen Suchtreffern und den Links freigegebener Quellen neue Quellenvorschläge, etwa
          nach einem Crawl.
        </RunOption>
        <RunOption
          form={
            <form action={crawlAllApprovedAction}>
              <Button>Alle freigegebenen crawlen</Button>
            </form>
          }
        >
          <span className="font-medium text-ink">Alle freigegebenen crawlen:</span> ein Abruf-Lauf über alle
          freigegebenen Quellen. Quellen, die ein anderer Lauf gerade abruft, werden übersprungen und genannt.
        </RunOption>
        <RunOption
          form={
            <form action={embedBackfillAction}>
              <Button>Einbettungen nachholen</Button>
            </form>
          }
        >
          <span className="font-medium text-ink">Einbettungen nachholen:</span> berechnet Einbettungen für alle Abschnitte,
          die noch keins haben. Läuft schon ein solcher Lauf, wird der Start abgelehnt.
        </RunOption>
        <RunOption
          form={
            <form action={pendingTextRunAction}>
              <Button>Neue Texte auswerten</Button>
            </form>
          }
        >
          <span className="font-medium text-ink">Neue Texte auswerten:</span> wertet jede aktuelle Version aller
          Quellen aus, die der Abgleich mit der aktuellen Konfiguration noch nicht durchlaufen hat (Erwähnungen, Facts,
          Zitatprüfung, Konsolidierung). Ohne neue Texte endet der Lauf sofort.
        </RunOption>
      </ul>
    </Dialog>
  );

  const createDialog = (
    <Dialog
      trigger="Quelle anlegen"
      triggerVariant="primary"
      title="Quelle anlegen"
      description="Eine manuell angelegte Quelle ist sofort freigegeben und bekommt die Standard-Crawl-Regeln. Gewicht und Änderungsrate kommen vom Typ."
    >
      <form action={createSourceAction} className="grid gap-4">
        <Field label="Domain" hint="Domain oder eine URL der Website; gespeichert wird die registrierbare Domain (z. B. example.org).">
          <input name="domain" required placeholder="Domain oder URL" aria-label="Domain" className={inputClass} />
        </Field>
        <Field label="Name" hint="Anzeigename in Listen und Prüfungen.">
          <input name="name" required placeholder="Name" aria-label="Name" className={inputClass} />
        </Field>
        <Field label="Typ" hint="Art der Texte; bestimmt Gewicht und Änderungsrate der neuen Quelle.">
          <select name="type" required aria-label="Typ" className={inputClass}>
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {DOC_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex justify-end">
          <Button variant="primary">Anlegen (freigegeben)</Button>
        </div>
      </form>
    </Dialog>
  );

  return (
    <>
      {active && <AutoRefresh intervalMs={5000} />}
      <PageHeader
        title="Quellen"
        description="Websites, aus denen Periplus Texte sammelt. Vorgeschlagene Quellen warten auf eine Prüfung, nur freigegebene werden gecrawlt."
        actions={
          <>
            {runDialog}
            {createDialog}
          </>
        }
      />

      <div className="space-y-4">
        {error && (
          <Notice tone="danger" title="Nicht ausgeführt">
            {error}
          </Notice>
        )}
        {startedRun && (
          <Notice tone="ok" title="Lauf gestartet">
            <Link href={`/runs/${startedRun}`} className="text-accent hover:underline">
              Lauf <Mono>{startedRun.slice(0, 8)}</Mono> ansehen
            </Link>
            {skipped.length > 0 && <> – übersprungen, läuft bereits: {skipped.map((s) => s.domain).join(", ")}</>}
          </Notice>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <FilterChips
            label="Quellen je Status"
            items={[
              { href: href({ status: undefined }), label: "Alle", count: allCount, current: !status },
              ...sourceStatusEnum.enumValues.map((s) => ({
                href: href({ status: s }),
                label: SOURCE_STATUS_LABELS[s],
                count: counts[s],
                current: status === s,
              })),
            ]}
          />
          <form method="get" role="search" className="flex flex-wrap items-center gap-2">
            {status && <input type="hidden" name="status" value={status} />}
            <select name="type" defaultValue={type ?? ""} aria-label="Typ" className={inputClass}>
              <option value="">Alle Typen</option>
              {DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOC_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Domain oder Name"
              aria-label="Suche"
              className={`${inputClass} w-48`}
            />
            <Button>Filtern</Button>
          </form>
        </div>

        <Panel flush>
          {list.rows.length === 0 ? (
            <EmptyState title={filtered ? "Keine Quelle passt zum Filter" : "Noch keine Quellen"}>
              {filtered
                ? "Filter ändern oder zurücksetzen."
                : "Quellen entstehen durch die Quellenfindung (als Vorschläge zur Prüfung), durch Wikivoyage oder manuell über „Quelle anlegen“."}
            </EmptyState>
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <th className={thClass}>Domain</th>
                    <th className={thClass}>Status</th>
                    <th className={thClass}>Typ</th>
                    <th className={`${thClass} text-right`} title="Gewicht der Quelle (0 bis 1) in der Konsolidierung">
                      Gewicht
                    </th>
                    <th className={`${thClass} text-right`}>Dokumente</th>
                    <th className={`${thClass} text-right`}>Versionen</th>
                    <th className={thClass}>Letzter Lauf</th>
                    <th className={`${thClass} text-right`}>Kosten 30 Tage</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr key={r.id} className={trClass}>
                      <td className={tdClass}>
                        <Link href={`/sources/${r.id}`} className="font-medium text-accent hover:underline">
                          {r.domain}
                        </Link>
                        {r.name !== r.domain && <div className="text-xs text-muted">{r.name}</div>}
                      </td>
                      <td className={tdClass}>
                        <Badge tone={SOURCE_STATUS_TONES[r.status]}>{SOURCE_STATUS_LABELS[r.status]}</Badge>
                      </td>
                      <td className={`${tdClass} whitespace-nowrap`}>{DOC_TYPE_LABELS[r.type]}</td>
                      <td className={`${tdClass} ${numClass}`}>{weight(r.weight)}</td>
                      <td className={`${tdClass} ${numClass}`}>{fmt.int(r.documents)}</td>
                      <td className={`${tdClass} ${numClass}`}>{fmt.int(r.versions)}</td>
                      <td className={`${tdClass} whitespace-nowrap`}>
                        {r.lastRun ? (
                          <Link
                            href={`/runs/${r.lastRun.id}`}
                            className="inline-flex items-center gap-2 hover:underline"
                            title={fmt.dateTime(r.lastRun.finishedAt)}
                          >
                            <RunStatusBadge status={r.lastRun.status} />
                            {r.lastRun.finishedAt && <span className="text-xs text-muted">{fmt.ago(r.lastRun.finishedAt, now)}</span>}
                          </Link>
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                      <td className={`${tdClass} ${numClass}`}>{fmt.eur(r.costEur30d)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <div className="border-t border-line">
                <Pagination
                  page={page}
                  pages={pages}
                  total={list.total}
                  noun="Quellen"
                  href={(p) => href({ page: String(p) })}
                />
              </div>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
