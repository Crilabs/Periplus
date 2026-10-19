import Link from "next/link";
import { formatProfileValue } from "@/lib/domain/consolidation/format";
import type { ConflictNote } from "@/lib/domain/consolidation/types";
import type { AttributeFactsView, ProfileRow, ProfileView } from "@/lib/domain/profile-view";
import {
  COMPUTATION_KIND_LABELS,
  CONFIDENCE_CLASS_LABELS,
  CONFLICT_RESOLUTION_LABELS,
  PROFILE_NOTICE_LABELS,
  PROVENANCE_ORIGIN_LABELS,
  profileGapReasonLabel,
  SUMMARY_STATUS_LABELS,
} from "../../_components/labels";
import { removeProfileEntryAction } from "./actions";
import { FactCard } from "./facts-tab";

const share = (n: number) => n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const time = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

/** Where the profile table links to: the attribute's facts (`attr`), and where „Eintrag entfernen“ returns to. */
export type ProfileLinks = { geoObjectId: string; attrHref: (attribute: string | null) => string; placeId?: string };

/**
 * The profile tab of the place page (`?tab=profile&attr=<key>`) and the profile section of the geo page: head
 * (version, validity, rules version, profile confidence, popularity, sources and documents, summary), the table of
 * attributes with their provenance, the facts of the clicked attribute, derived values and gaps.
 */
export function ProfileTab({
  view,
  selected,
  links,
  notice,
  noticeRunId,
}: {
  view: ProfileView | null;
  selected: AttributeFactsView | null;
  links: ProfileLinks;
  notice?: string | null;
  noticeRunId?: string | null;
}) {
  return (
    <div className="space-y-4">
      {notice && PROFILE_NOTICE_LABELS[notice] && (
        <p role="status" className={`rounded px-3 py-2 ${notice === "entry_removed" ? "bg-green-100" : "bg-amber-100"}`}>
          {PROFILE_NOTICE_LABELS[notice]}
          {noticeRunId && (
            <>
              {" "}
              <Link href={`/runs/${noticeRunId}`} className="underline">
                Lauf ansehen
              </Link>
            </>
          )}
        </p>
      )}
      {view ? <ProfileBody view={view} selected={selected} links={links} /> : <p>Noch kein Profil.</p>}
    </div>
  );
}

function ProfileBody({ view, selected, links }: { view: ProfileView; selected: AttributeFactsView | null; links: ProfileLinks }) {
  const s = view.snapshot;
  return (
    <>
      <dl className="grid grid-cols-[10rem_1fr] gap-y-1">
        <dt>Version</dt>
        <dd>
          {s.version} von {view.versions}
          {!view.latest && " (ältere Version)"}
        </dd>
        <dt>Gültig ab</dt>
        <dd>{s.validFrom}</dd>
        <dt>Regelversion</dt>
        <dd>
          {s.rulesVersion} · Fact-Schema {s.factSchemaVersion}
        </dd>
        <dt>Profil-Konfidenz</dt>
        <dd>{s.confidence === null ? "–" : share(s.confidence)}</dd>
        <dt>Beliebtheit</dt>
        <dd>{view.popularity === null ? "–" : share(view.popularity)}</dd>
        <dt>Quellen / Dokumente</dt>
        <dd>
          {s.sourcesCount} / {s.documentsCount}
        </dd>
        <dt>Erstellt</dt>
        <dd>
          {time(view.createdAt)}
          {view.runId && (
            <>
              {" "}
              · Lauf{" "}
              <Link href={`/runs/${view.runId}`} className="font-mono underline">
                {view.runId.slice(0, 8)}
              </Link>
            </>
          )}
        </dd>
        {view.identity.map((i) => (
          <div key={i.attribute} className="contents">
            <dt>{i.label}</dt>
            <dd>{i.display}</dd>
          </div>
        ))}
        <dt>Zusammenfassung</dt>
        <dd className="max-w-3xl">
          {view.summary === null ? "–" : view.summary.text ?? `(${SUMMARY_STATUS_LABELS[view.summary.status]})`}
        </dd>
      </dl>

      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-neutral-300">
            <th className="py-1 pr-4">Attribut</th>
            <th className="pr-4">Wert</th>
            <th className="pr-4">Konfidenz</th>
            <th className="pr-4">Herkunft</th>
            <th className="pr-4">Regel</th>
            <th className="pr-4">beobachtet</th>
            <th>bestätigt</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r) => (
            <RowView key={r.attribute} row={r} links={links} selected={selected?.row.attribute === r.attribute ? selected : null} version={s.version} />
          ))}
        </tbody>
      </table>

      {view.derived.length > 0 && (
        <section>
          <h2 className="mb-1 font-semibold">Abgeleitet</h2>
          <ul>
            {view.derived.map((d) => (
              <li key={d.attribute}>
                <Link href={links.attrHref(d.attribute)} className="underline">
                  {d.label}
                </Link>
                : {d.display}
              </li>
            ))}
          </ul>
          {selected && selected.row.rule === "derived" && <AttributeDetail detail={selected} links={links} version={s.version} />}
        </section>
      )}

      <section>
        <h2 className="mb-1 font-semibold">Lücken</h2>
        {view.gaps.length === 0 ? (
          <p>Keine Lücken.</p>
        ) : (
          <ul>
            {view.gaps.map((g) => (
              <li key={g.attribute}>
                {g.label} <span className="font-mono text-xs text-neutral-500">{g.attribute}</span>: {profileGapReasonLabel(g.reason)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function RowView({ row: r, links, selected, version }: { row: ProfileRow; links: ProfileLinks; selected: AttributeFactsView | null; version: number }) {
  return (
    <>
      <tr className={`border-b border-neutral-200 align-top ${selected ? "bg-sky-50" : ""}`}>
        <td className="py-1 pr-4">
          <Link href={links.attrHref(selected ? null : r.attribute)} aria-current={selected ? "true" : undefined} className="underline">
            {r.label}
          </Link>{" "}
          <span className="font-mono text-xs text-neutral-500">{r.attribute}</span>
        </td>
        <td className="pr-4">
          {r.display}
          <Markers row={r} />
        </td>
        <td className="pr-4">
          {CONFIDENCE_CLASS_LABELS[r.confidenceClass]} ({share(r.confidence)})
        </td>
        <td className="pr-4">{PROVENANCE_ORIGIN_LABELS[r.origin]}</td>
        <td className="pr-4 text-xs">{r.ruleLabel}</td>
        <td className="pr-4">{r.observedAt ?? "–"}</td>
        <td>{r.lastConfirmedAt ?? "–"}</td>
      </tr>
      {selected && (
        <tr className="border-b border-neutral-300 bg-sky-50">
          <td colSpan={7} className="p-2">
            <AttributeDetail detail={selected} links={links} version={version} />
          </td>
        </tr>
      )}
    </>
  );
}

/** A conflict decided seasonally or left open stays so for this value pair (ruling M5-F-R3 M-6). */
function ConflictMarker({ row: r, conflict: c }: { row: ProfileRow; conflict: ConflictNote }) {
  return (
    <span className="block text-xs text-red-800">
      Konflikt: {formatProfileValue(r.attribute, c.a.value)} ↔ {formatProfileValue(r.attribute, c.b.value)}
      {c.others.length > 0 && ` (+${c.others.length} weitere)`}
      {c.resolution && ` · ${CONFLICT_RESOLUTION_LABELS[c.resolution]}`}
      {(c.resolution === "seasonal" || c.resolution === "left_open") && " (dauerhaft für dieses Wertepaar)"}
      {r.conflictTaskId && (
        <>
          {" "}
          ·{" "}
          <Link href={`/review/${r.conflictTaskId}`} className="underline">
            Aufgabe
          </Link>
        </>
      )}
    </span>
  );
}

function Markers({ row: r }: { row: ProfileRow }) {
  return (
    <>
      {r.conflict && <ConflictMarker row={r} conflict={r.conflict} />}
      {r.expired && <span className="block text-xs text-amber-800">abgelaufen</span>}
      {r.onlyGoneSources && <span className="block text-xs text-amber-800">nur verschwundene Quellen</span>}
      {r.pending && (
        <span className="block text-xs text-amber-800">
          Änderung in Prüfung: {r.pending.display} ·{" "}
          <Link href={`/review/${r.pending.taskId}`} className="underline">
            Aufgabe
          </Link>
        </span>
      )}
    </>
  );
}

function AttributeDetail({ detail: d, links, version }: { detail: AttributeFactsView; links: ProfileLinks; version: number }) {
  const r = d.row;
  return (
    <div className="space-y-3">
      {r.conflict && (
        <div>
          <h3 className="font-semibold">Konflikt</h3>
          <ul className="text-xs">
            {[r.conflict.a, r.conflict.b, ...r.conflict.others].map((side, i) => (
              <li key={i}>
                {i === 0 ? "A" : i === 1 ? "B" : "weiterer Wert"}: {formatProfileValue(r.attribute, side.value)} · Gewicht {share(side.weight)} ·{" "}
                {side.observedFrom === side.observedTo ? side.observedFrom : `${side.observedFrom} – ${side.observedTo}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.entries && (
        <div>
          <h3 className="font-semibold">Einträge</h3>
          <ul className="space-y-2">
            {d.entries.map((e) => (
              <li key={e.key} className="max-w-3xl rounded border border-neutral-200 p-2">
                <p>
                  <span className="font-semibold">{e.display}</span> · {e.inputIds.length} {e.inputIds.length === 1 ? "Beleg" : "Belege"}
                  {e.otherInputs.length > 0 && ` (davon ${e.otherInputs.length} aus Berechnung/POI)`}
                </p>
                {e.removable && (
                  <form action={removeProfileEntryAction} className="mt-1">
                    <input type="hidden" name="geoObjectId" value={links.geoObjectId} />
                    <input type="hidden" name="attribute" value={r.attribute} />
                    <input type="hidden" name="entryKey" value={e.key} />
                    <input type="hidden" name="version" value={version} />
                    {links.placeId && <input type="hidden" name="placeId" value={links.placeId} />}
                    <button type="submit" className="rounded border border-red-400 px-2 py-0.5 text-xs hover:bg-red-50">
                      Eintrag entfernen
                    </button>
                  </form>
                )}
                {e.facts.length > 0 && (
                  <ul className="mt-1 space-y-1">
                    {e.facts.map((f) => (
                      <FactCard key={f.id} fact={f} />
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="font-semibold">Facts ({d.facts.length})</h3>
        {d.facts.length === 0 ? (
          <p>Keine Facts.</p>
        ) : (
          <ul className="space-y-2">
            {d.facts.map((f) => (
              <FactCard key={f.id} fact={f} />
            ))}
          </ul>
        )}
      </div>
      {d.computations.length > 0 && (
        <div>
          <h3 className="font-semibold">Berechnungen</h3>
          <ul>
            {d.computations.map((c) => (
              <li key={c.id}>
                {COMPUTATION_KIND_LABELS[c.kind as keyof typeof COMPUTATION_KIND_LABELS] ?? c.kind} vom {time(c.createdAt)}{" "}
                <span className="font-mono text-xs text-neutral-500">{c.id.slice(0, 8)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.pois.length > 0 && (
        <div>
          <h3 className="font-semibold">POIs</h3>
          <ul>
            {d.pois.map((p) => (
              <li key={p.id}>
                <Link href={`/geo/${p.id}`} className="underline">
                  {p.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.derivedFrom && (
        <div>
          <h3 className="font-semibold">Herleitung</h3>
          <pre className="max-w-3xl overflow-x-auto text-xs">{JSON.stringify(r.derivedFrom, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
