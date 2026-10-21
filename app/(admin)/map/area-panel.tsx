"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AreaDetail } from "@/lib/domain/areas/view";
import { GEO_OBJECT_TYPE_LABELS, languageLabel } from "../_components/labels";
import { countryName } from "@/lib/domain/subdivisions/country-name";
import { cx } from "../_components/ui";

const typeLabel = (type: string): string => GEO_OBJECT_TYPE_LABELS[type as keyof typeof GEO_OBJECT_TYPE_LABELS] ?? type;
const RELATION_LABELS: Record<string, string> = { contains: "enthält", within: "liegt in", overlaps: "überlappt" };
const LANGUAGE_ORDER = ["de", "en", "el"];

type State = { id: string; detail: AreaDetail | null; error: boolean };

/** Hostnames only for the evidence link text; the whole URL stays the target. */
function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Only http(s) links are rendered as links (the URL comes from a file). */
const safeHref = (url: string): string | null => (/^https?:\/\//i.test(url) ? url : null);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-medium text-muted">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The read-only detail of a Revier in the map sidebar: names per language (preferred bold), members (resolved ones as
 * links to the geo object, open ones grey with their type), boundary, relations, evidence, notes. Loaded from
 * `/map/area-detail/<id>` on selection. Corrections happen in the Revier-Bot.
 */
export function AreaPanel({ areaId, fallbackName }: { areaId: string; fallbackName: string }) {
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/map/area-detail/${encodeURIComponent(areaId)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as AreaDetail) : Promise.reject(new Error(String(res.status)))))
      .then((detail) => setState({ id: areaId, detail, error: false }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ id: areaId, detail: null, error: true });
      });
    return () => controller.abort();
  }, [areaId]);

  const current = state?.id === areaId ? state : null;
  if (!current) return <p role="status" className="text-muted">Lädt …</p>;
  const d = current.detail;
  if (!d) return <p role="alert" className="text-danger">Revier {fallbackName} konnte nicht geladen werden.</p>;

  const languages = [...new Set(d.names.map((n) => n.language))].sort(
    (a, b) => (LANGUAGE_ORDER.indexOf(a) + 1 || 99) - (LANGUAGE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b),
  );
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-muted">Schlüssel</dt>
        <dd className="min-w-0 break-words">{d.key || "–"}</dd>
        <dt className="text-muted">Öffentliche ID</dt>
        <dd className="min-w-0 break-words">{d.publicId ?? "–"}</dd>
        <dt className="text-muted">Land</dt>
        <dd>{d.importedFrom ? countryName(d.importedFrom) : "–"}</dd>
        <dt className="text-muted">Landesteile</dt>
        <dd className="min-w-0 break-words">{d.subdivisions.length ? d.subdivisions.map((s) => s.name).join(", ") : "–"}</dd>
        <dt className="text-muted">Polygon</dt>
        <dd>{d.polygonOrigin || "–"}</dd>
      </dl>

      <Section title="Namen">
        <ul className="space-y-0.5">
          {languages.map((language) => (
            <li key={language} className="flex gap-2">
              <span className={cx("shrink-0 text-muted", language === "und" ? "min-w-6" : "w-6 uppercase")}>{languageLabel(language)}</span>
              <span className="min-w-0">
                {d.names
                  .filter((n) => n.language === language)
                  .map((n, i) => (
                    <span key={n.name}>
                      {i > 0 && ", "}
                      <span className={cx(n.isPreferred && "font-semibold")}>{n.name}</span>
                    </span>
                  ))}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={`Mitglieder (${d.members.length + d.unresolvedMembers.length})`}>
        {d.members.length + d.unresolvedMembers.length === 0 && <p className="text-muted">–</p>}
        <ul className="space-y-0.5">
          {d.members.map((m) => (
            <li key={`${m.id}-${m.role}`}>
              <Link href={`/geo/${m.id}`} className="text-accent hover:underline">{m.name}</Link>{" "}
              <span className="text-muted">
                {typeLabel(m.type)}
                {m.role === "boundary" && ", Grenzpunkt"}
              </span>
            </li>
          ))}
          {d.unresolvedMembers.map((m) => (
            <li key={`${m.name}-${m.role}`} className="text-muted/70">
              {m.name} <span>({typeLabel(m.type)}{m.role === "boundary" && ", Grenzpunkt"}, nicht aufgelöst)</span>
            </li>
          ))}
        </ul>
      </Section>

      {d.boundary && (
        <Section title="Abgrenzung">
          <p className="break-words">{d.boundary}</p>
        </Section>
      )}

      {d.related.length > 0 && (
        <Section title="Beziehungen">
          <ul className="space-y-0.5">
            {d.related.map((r) => (
              <li key={`${r.relation}-${r.key}`}>
                {RELATION_LABELS[r.relation] ?? r.relation}{" "}
                {r.id ? <Link href={`/geo/${r.id}`} className="text-accent hover:underline">{r.name ?? r.key}</Link> : <span className="text-muted/70">{r.key}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Belege (${d.evidence.length})`}>
        {d.evidence.length === 0 && <p className="text-muted">–</p>}
        <ul className="space-y-2">
          {d.evidence.map((e) => {
            const href = safeHref(e.url);
            return (
              <li key={`${e.url}-${e.quote}`}>
                <blockquote lang={e.language} className="border-l-2 border-line-strong pl-2 break-words">„{e.quote}“</blockquote>
                <p className="text-xs text-muted">
                  {e.publisher || host(e.url)}
                  {" · "}
                  {href ? <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">{host(e.url)}</a> : e.url}
                </p>
              </li>
            );
          })}
        </ul>
      </Section>

      {d.notes && (
        <Section title="Notizen">
          <p className="break-words">{d.notes}</p>
        </Section>
      )}

      <p className="text-xs text-muted">Quelle: Revier-Bot, Korrekturen dort</p>
    </div>
  );
}
