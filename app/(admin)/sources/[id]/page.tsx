import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { changeRateEnum, DOC_TYPES, frontierStatusEnum } from "@/lib/db/schema";
import { documentOfOtherSource, SOURCES_PAGE_SIZE, sourceDetail } from "@/lib/domain/sources-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { AutoRefresh } from "../../_components/auto-refresh";
import { CrawlRulesFields } from "../../_components/crawl-rules-fields";
import {
  CHANGE_RATE_LABELS,
  DOC_TYPE_LABELS,
  DOCUMENT_STATUS_LABELS,
  FRONTIER_STATUS_LABELS,
  RUN_KIND_LABELS,
  RUN_STATUS_LABELS,
  SCOPE_TYPE_LABELS,
  SOURCE_ORIGIN_LABELS,
  SOURCE_STATUS_LABELS,
  sourcePageError,
} from "../../_components/labels";
import {
  crawlAction,
  pauseSourceAction,
  resumeSourceAction,
  saveSourceAction,
  testCrawlAction,
  uploadPdfAction,
} from "./actions";

const BUTTON = "rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-100";
const INPUT = "rounded border border-neutral-300 px-1 py-0.5";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SETTINGS_FIELDS = new Set(["name", "type", "weight", "changeRate"]);

const param = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const time = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "–");
const eur = (n: number) => `${n.toFixed(4)} €`;

export default async function Page({ params, searchParams }: PageProps<"/sources/[id]">) {
  await requireAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const docPage = Math.max(1, Number.parseInt(param(sp.docPage) ?? "1", 10) || 1);
  const db = getDb();
  const detail = await sourceDetail(db, id, { docPage });
  if (!detail) notFound();
  const { source, frontier, costs } = detail;
  const archivedParam = param(sp.archived);
  const archivedElsewhere = archivedParam && UUID.test(archivedParam) ? await documentOfOtherSource(db, archivedParam, id) : null;
  // An ended source is shown read-only: no crawl, status change, upload or saving.
  const ended = source.validTo !== null;
  const uploadable = !ended && (source.status === "approved" || source.status === "proposed");
  const error = sourcePageError(sp.error);
  const invalid = (param(sp.invalid) ?? "").split(",").filter((f) => f !== "");
  const mark = (field: string) =>
    invalid.includes(field) ? (
      <span role="alert" className="text-red-700">
        {" "}
        – ungültig
      </span>
    ) : null;
  const docPages = Math.max(1, Math.ceil(detail.documentTotal / SOURCES_PAGE_SIZE));
  const active = detail.runs.some((r) => r.status === "queued" || r.status === "running");
  const hidden = <input type="hidden" name="sourceId" value={source.id} />;

  return (
    <div className="space-y-6 text-sm">
      {active && <AutoRefresh intervalMs={5000} />}
      <div>
        <p>
          <Link href="/sources" className="underline">
            ← Quellen
          </Link>
        </p>
        <h1 className="text-lg font-semibold">{source.name}</h1>
      </div>
      {error && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2">
          Nicht ausgeführt: {error}
        </p>
      )}
      {invalid.length > 0 && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2">
          Nicht gespeichert: ungültige Felder sind markiert.
        </p>
      )}
      {archivedElsewhere && (
        <p role="status" className="rounded bg-amber-100 px-3 py-2">
          <Link href={`/documents/${archivedElsewhere.documentId}`} className="underline">
            Dieses Dokument
          </Link>{" "}
          ist bereits bei Quelle {archivedElsewhere.sourceDomain} archiviert.
        </p>
      )}
      {param(sp.saved) === "1" && (
        <p role="status" className="rounded bg-green-100 px-3 py-2">
          Gespeichert.
        </p>
      )}

      <dl className="grid grid-cols-[10rem_1fr] gap-y-1">
        <dt>Domain</dt>
        <dd>{source.domain}</dd>
        <dt>Status</dt>
        <dd>
          {SOURCE_STATUS_LABELS[source.status]}
          {source.statusReason ? ` (${source.statusReason})` : ""}
          {source.validTo ? `, beendet am ${source.validTo}` : ""}
        </dd>
        <dt>Herkunft</dt>
        <dd>{SOURCE_ORIGIN_LABELS[source.origin]}</dd>
        <dt>Sprachen</dt>
        <dd>{source.languages.join(", ") || "–"}</dd>
        <dt>Angelegt</dt>
        <dd>{time(source.createdAt)}</dd>
        <dt>Frontier</dt>
        <dd>{frontierStatusEnum.enumValues.map((s) => `${FRONTIER_STATUS_LABELS[s]}: ${frontier[s]}`).join(" · ")}</dd>
        <dt>Kosten</dt>
        <dd>
          {eur(costs.totalEur)}
          {costs.byService.length > 0 &&
            ` (${costs.byService.map((c) => `${c.service}: ${c.calls} Aufrufe, ${eur(c.costEur)}`).join(" · ")})`}
        </dd>
      </dl>

      <section className="flex flex-wrap gap-2">
        {!ended && source.status === "approved" && (
          <>
            <form action={testCrawlAction}>
              {hidden}
              <button type="submit" className={BUTTON}>
                Testcrawl 10 Seiten
              </button>
            </form>
            <form action={crawlAction}>
              {hidden}
              <button type="submit" className={BUTTON}>
                Crawlen
              </button>
            </form>
            <form action={pauseSourceAction}>
              {hidden}
              <button type="submit" className={BUTTON}>
                Pausieren
              </button>
            </form>
          </>
        )}
        {!ended && source.status === "paused" && (
          <form action={resumeSourceAction}>
            {hidden}
            <button type="submit" className={BUTTON}>
              Fortsetzen
            </button>
          </form>
        )}
      </section>

      {uploadable && (
        <form action={uploadPdfAction} className="flex flex-wrap items-center gap-2">
          {hidden}
          <label className="flex items-center gap-2">
            PDF hochladen (höchstens 100 MB)
            <input type="file" name="file" accept="application/pdf,.pdf" required />
          </label>
          <button type="submit" className={BUTTON}>
            Hochladen und archivieren
          </button>
        </form>
      )}

      <section>
        <h2 className="mb-2 font-semibold">Einstellungen</h2>
        <form action={saveSourceAction} className="grid max-w-3xl gap-3">
          {hidden}
          <fieldset disabled={ended} className="contents">
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-1">
                Name
                <input name="name" required maxLength={200} defaultValue={source.name} className={INPUT} />
                {mark("name")}
              </label>
              <label className="flex items-center gap-1">
                Typ
                <select name="type" defaultValue={source.type} className={INPUT}>
                  {DOC_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {DOC_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
                {mark("type")}
              </label>
              <label className="flex items-center gap-1">
                Gewicht
                <input
                  type="number"
                  name="weight"
                  required
                  min={0}
                  max={1}
                  step="any"
                  defaultValue={source.weight}
                  className={`${INPUT} w-20`}
                />
                {mark("weight")}
              </label>
              <label className="flex items-center gap-1">
                Änderungsrate
                <select name="changeRate" defaultValue={source.changeRate} className={INPUT}>
                  {changeRateEnum.enumValues.map((c) => (
                    <option key={c} value={c}>
                      {CHANGE_RATE_LABELS[c]}
                    </option>
                  ))}
                </select>
                {mark("changeRate")}
              </label>
            </div>
            <CrawlRulesFields defaults={source.crawlRules} invalid={invalid.filter((f) => !SETTINGS_FIELDS.has(f))} />
          </fieldset>
          {!ended && (
            <div>
              <button type="submit" className={BUTTON}>
                Speichern
              </button>
            </div>
          )}
        </form>
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Dokumente ({detail.documentTotal})</h2>
        {detail.documents.length === 0 ? (
          <p>Keine Dokumente.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-neutral-300">
                  <th className="py-1 pr-4">URL</th>
                  <th className="pr-4">Status</th>
                  <th className="pr-4">Versionen</th>
                  <th className="pr-4">Zuletzt geprüft</th>
                  <th>Sprache</th>
                </tr>
              </thead>
              <tbody>
                {detail.documents.map((d) => (
                  <tr key={d.id} className="border-b border-neutral-200">
                    <td className="max-w-xl truncate py-1 pr-4">
                      <Link href={`/documents/${d.id}`} className="underline">
                        {d.url}
                      </Link>
                    </td>
                    <td className="pr-4">{DOCUMENT_STATUS_LABELS[d.status]}</td>
                    <td className="pr-4 tabular-nums">{d.versions}</td>
                    <td className="pr-4 whitespace-nowrap">{time(d.lastCheckedAt)}</td>
                    <td>{d.language ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {docPages > 1 && (
          <nav aria-label="Dokumentseiten" className="mt-2 flex items-center gap-3">
            {docPage > 1 && <Link href={`/sources/${source.id}?docPage=${docPage - 1}`}>← Zurück</Link>}
            <span>
              Seite {docPage} von {docPages}
            </span>
            {docPage < docPages && <Link href={`/sources/${source.id}?docPage=${docPage + 1}`}>Weiter →</Link>}
          </nav>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Letzte Läufe</h2>
        {detail.runs.length === 0 ? (
          <p>Keine Läufe.</p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-neutral-300">
                <th className="py-1 pr-4">Lauf</th>
                <th className="pr-4">Art</th>
                <th className="pr-4">Umfang</th>
                <th className="pr-4">Stufen</th>
                <th className="pr-4">Status</th>
                <th className="pr-4">Angelegt</th>
                <th>Beendet</th>
              </tr>
            </thead>
            <tbody>
              {detail.runs.map((r) => (
                <tr key={r.id} className="border-b border-neutral-200">
                  <td className="py-1 pr-4">
                    <Link href={`/runs/${r.id}`} className="font-mono text-xs underline">
                      {r.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="pr-4">{RUN_KIND_LABELS[r.kind]}</td>
                  <td className="pr-4">
                    {SCOPE_TYPE_LABELS[r.scopeType]}: {r.scopeId === source.id ? "diese Quelle" : r.scopeId}
                  </td>
                  <td className="pr-4">{r.stages.join(", ")}</td>
                  <td className="pr-4">{RUN_STATUS_LABELS[r.status]}</td>
                  <td className="pr-4 whitespace-nowrap">{time(r.createdAt)}</td>
                  <td className="whitespace-nowrap">{time(r.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
