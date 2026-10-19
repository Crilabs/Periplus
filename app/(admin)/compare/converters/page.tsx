import Link from "next/link";
import type { ConverterName } from "@/lib/adapters/fetch";
import { getArchive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import {
  CONVERTER_SAMPLE,
  converterSampleDetail,
  converterSummary,
  listConverterSamples,
  sampleRated,
  type OutputState,
  type SampleOutput,
} from "@/lib/domain/converter-comparison";
import { CONVERTERS } from "@/lib/domain/sources/crawl-rules";
import { requireAdmin } from "@/lib/security/require-admin";
import { ArchiveMarkdown } from "../../_components/archive-markdown";
import { comparePageError } from "../../_components/labels";
import { rateOutputAction, startComparisonAction } from "./actions";

const BUTTON = "rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-100";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CONVERTER_LABELS: Record<ConverterName, string> = { jina: "Jina", firecrawl: "Firecrawl", local: "Lokal" };

const param = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const percent = (v: number | null) => (v === null ? "–" : `${v.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`);
const eur = (n: number) => `${n.toLocaleString("de-DE", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} €`;
const seconds = (ms: number) => `${(ms / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} s`;

function outputState(o: OutputState | undefined): string {
  if (!o) return "offen";
  if (o.error) return "Fehler";
  return o.rating ? "bewertet" : "zu bewerten";
}

function RatingForm({ sampleId, output }: { sampleId: string; output: SampleOutput }) {
  const r = output.rating;
  const tables = r?.tablesKept === undefined || r.tablesKept === null ? "" : r.tablesKept ? "yes" : "no";
  return (
    <form action={rateOutputAction} className="space-y-1" aria-label={`Bewertung ${CONVERTER_LABELS[output.converter]}`}>
      <input type="hidden" name="sampleId" value={sampleId} />
      <input type="hidden" name="converter" value={output.converter} />
      <label className="flex items-center gap-2">
        <input type="checkbox" name="mainContent" defaultChecked={r?.mainContent ?? false} />
        Hauptinhalt vollständig
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="boilerplateRemoved" defaultChecked={r?.boilerplateRemoved ?? false} />
        Boilerplate entfernt
      </label>
      <label className="flex items-center gap-2">
        Tabellen
        <select name="tablesKept" defaultValue={tables} className="rounded border border-neutral-400 px-1">
          <option value="">Seite ohne Tabellen</option>
          <option value="yes">erhalten</option>
          <option value="no">verloren oder zerstört</option>
        </select>
      </label>
      <button type="submit" className={BUTTON}>
        Speichern
      </button>
      {output.ratedBy && <p className="text-xs text-neutral-500">Bewertet von {output.ratedBy}</p>}
    </form>
  );
}

export default async function Page({ searchParams }: PageProps<"/compare/converters">) {
  await requireAdmin();
  const sp = await searchParams;
  const sampleParam = param(sp.sample);
  const error = comparePageError(sp.error);
  const db = getDb();
  const [summary, samples] = await Promise.all([converterSummary(db), listConverterSamples(db)]);
  const detail = sampleParam && UUID.test(sampleParam) ? await converterSampleDetail(db, getArchive(), sampleParam) : null;
  const rated = samples.filter(sampleRated).length;
  const { fetch } = getConfig();
  const exceptions = Object.entries(fetch.converterBySource);
  const nextOpen = samples.find((s) => !sampleRated(s) && s.id !== detail?.id);

  return (
    <div className="space-y-6 text-sm">
      <h1 className="text-lg font-semibold">Konverter-Vergleich</h1>
      {error && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2">
          Nicht ausgeführt: {error}
        </p>
      )}
      <p className="rounded bg-neutral-100 px-3 py-2">
        Aktuelle Entscheidung (<code>config/fetch.json</code>):{" "}
        <strong>{fetch.decision.status === "decided" ? "Entschieden" : "Vorläufig"}</strong> – Standard{" "}
        <code>{fetch.defaultConverter}</code>
        {exceptions.length > 0 && <>, Ausnahmen: {exceptions.map(([d, c]) => `${d} → ${c}`).join(", ")}</>}. {fetch.decision.note}
      </p>

      <section className="flex flex-wrap items-center gap-4">
        <form action={startComparisonAction}>
          <button type="submit" className={BUTTON}>
            Vergleich starten
          </button>
        </form>
        <p>
          <strong className="tabular-nums">
            {rated} von {CONVERTER_SAMPLE.pages}
          </strong>{" "}
          bewertet ({samples.length} Seiten in der Stichprobe)
        </p>
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Zusammenfassung</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-neutral-300">
                <th className="py-1 pr-4">Konverter</th>
                <th className="pr-4">Seiten</th>
                <th className="pr-4">Fehler</th>
                <th className="pr-4">Bewertet</th>
                <th className="pr-4">Hauptinhalt</th>
                <th className="pr-4">Boilerplate entfernt</th>
                <th className="pr-4">Tabellen erhalten</th>
                <th className="pr-4">Kosten je Seite</th>
                <th className="pr-4">Laufzeit je Seite</th>
                <th>Zeichen je Seite</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.converter} className="border-b border-neutral-200 tabular-nums">
                  <td className="py-1 pr-4">{CONVERTER_LABELS[s.converter]}</td>
                  <td className="pr-4">{s.pages}</td>
                  <td className="pr-4">{s.errors}</td>
                  <td className="pr-4">{s.rated}</td>
                  <td className="pr-4">{percent(s.mainContentPct)}</td>
                  <td className="pr-4">{percent(s.boilerplatePct)}</td>
                  <td className="pr-4">{percent(s.tablesPct)}</td>
                  <td className="pr-4">{eur(s.avgCostEur)}</td>
                  <td className="pr-4">{seconds(s.avgDurationMs)}</td>
                  <td>{s.avgChars}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {detail && (
        <section className="space-y-3" aria-label="Seitenansicht">
          <h2 className="font-semibold break-all">
            {detail.domain}:{" "}
            <a href={detail.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">
              {detail.url}
            </a>
          </h2>
          {nextOpen && (
            <p>
              <Link href={`/compare/converters?sample=${nextOpen.id}`} className="underline">
                Nächste offene Seite →
              </Link>
            </p>
          )}
          <div className="grid gap-4 lg:grid-cols-3">
            {CONVERTERS.map((name) => {
              const output = detail.outputs.find((o) => o.converter === name);
              return (
                <div key={name} id={name} className="min-w-0 space-y-2 rounded border border-neutral-300 p-3">
                  <h3 className="font-semibold">{CONVERTER_LABELS[name]}</h3>
                  {!output ? (
                    <p>Noch nicht umgewandelt.</p>
                  ) : output.error ? (
                    <p role="alert" className="rounded bg-red-100 px-2 py-1 break-words">
                      Fehler: {output.error}
                    </p>
                  ) : (
                    <>
                      <p className="text-xs text-neutral-600 tabular-nums">
                        {output.chars} Zeichen · {seconds(output.durationMs)} · {eur(output.costEur)}
                      </p>
                      <RatingForm sampleId={detail.id} output={output} />
                      <div className="max-h-[70vh] overflow-auto border-t border-neutral-200 pt-2">
                        {output.markdown === null ? <p>Markdown fehlt im Archiv.</p> : <ArchiveMarkdown markdown={output.markdown} />}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-1 font-semibold">Seiten</h2>
        {samples.length === 0 ? (
          <p>Noch keine Stichprobe – „Vergleich starten“ wählt 50 Seiten der größten freigegebenen Quellen.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-neutral-300">
                  <th className="py-1 pr-4">Quelle</th>
                  <th className="pr-4">Seite</th>
                  {CONVERTERS.map((c) => (
                    <th key={c} className="pr-4">
                      {CONVERTER_LABELS[c]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {samples.map((s) => (
                  <tr key={s.id} className={`border-b border-neutral-200 ${s.id === detail?.id ? "bg-neutral-100" : ""}`}>
                    <td className="py-1 pr-4">{s.domain}</td>
                    <td className="pr-4 break-all">
                      <Link href={`/compare/converters?sample=${s.id}`} className="underline">
                        {s.url}
                      </Link>
                    </td>
                    {CONVERTERS.map((c) => (
                      <td key={c} className="pr-4">
                        {outputState(s.outputs[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
