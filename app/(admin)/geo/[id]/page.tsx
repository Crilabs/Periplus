import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { geoFacts, geoMentions, MENTIONS_PER_PAGE } from "@/lib/domain/geo-facts";
import { geoObjectDetail, type GeoObjectRef } from "@/lib/domain/geo-view";
import { profileAttributeFacts, profileView } from "@/lib/domain/profile-view";
import { requireAdmin } from "@/lib/security/require-admin";
import {
  GEO_OBJECT_TYPE_LABELS,
  GEO_ORIGIN_LABELS,
  MATCH_KIND_LABELS,
  NAME_ORIGIN_LABELS,
  PLACE_KIND_LABELS,
  PLACE_STATUS_LABELS,
  runScopeError,
} from "../../_components/labels";
import { AnnotatedText } from "../../_components/annotated-text";
import { recomputeGeoProfileAction } from "../../places/[id]/actions";
import { FactsTab } from "../../places/[id]/facts-tab";
import { ProfileTab } from "../../places/[id]/profile-tab";

const SCRIPT_LABELS = { latin: "Lateinisch", greek: "Griechisch" } as const;
const runsParam = z.enum(["active", "all"]).catch("active");
const pageParam = z.coerce.number().int().min(1).catch(1);
const textParam = z.string().max(200).optional().catch(undefined);
const uuidParam = z.uuid().optional().catch(undefined);
const share = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });

function GeoLink({ o }: { o: GeoObjectRef }) {
  return (
    <>
      <Link href={`/geo/${o.id}`} className="underline">
        {o.name ?? o.id}
      </Link>{" "}
      ({GEO_OBJECT_TYPE_LABELS[o.type]})
    </>
  );
}

export default async function Page({ params, searchParams }: PageProps<"/geo/[id]">) {
  await requireAdmin();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const db = getDb();
  const detail = await geoObjectDetail(db, id.data);
  if (!detail) notFound();
  const sp = await searchParams;
  const runs = runsParam.parse(sp.runs);
  const page = pageParam.parse(sp.mp);
  const error = runScopeError(sp.error);
  const attr = textParam.parse(sp.attr);
  const [mentionPage, facts, profile] = await Promise.all([
    geoMentions(db, id.data, page),
    geoFacts(db, id.data, { runs }),
    profileView(db, id.data),
  ]);
  const selected = profile && attr ? await profileAttributeFacts(db, id.data, profile.snapshot.version, attr) : null;
  const pages = Math.max(1, Math.ceil(mentionPage.total / MENTIONS_PER_PAGE));
  const href = (q: { runs?: "active" | "all"; mp?: number; attr?: string | null }) => {
    const r = q.runs ?? runs;
    const m = q.mp ?? page;
    const a = q.attr === undefined ? attr : q.attr;
    const parts = [r === "all" ? "runs=all" : "", m > 1 ? `mp=${m}` : "", a ? `attr=${encodeURIComponent(a)}` : ""].filter(Boolean);
    return `/geo/${id.data}${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
  };
  const { object: o } = detail;
  const externalIds = [
    o.osmId && `OSM ${o.osmId}`,
    o.wikidataId && `Wikidata ${o.wikidataId}`,
    o.geonamesId && `GeoNames ${o.geonamesId}`,
  ].filter(Boolean);
  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-lg font-semibold">
        {o.name ?? o.id} ({GEO_OBJECT_TYPE_LABELS[o.type]})
      </h1>
      {error && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2">
          Lauf nicht gestartet: {error}
        </p>
      )}
      <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
        <dt>Eltern-Kette</dt>
        <dd>
          {detail.ancestors.length === 0
            ? "–"
            : detail.ancestors.map((a, i) => (
                <span key={a.id}>
                  {i > 0 && " → "}
                  <GeoLink o={a} />
                </span>
              ))}
        </dd>
        <dt>Herkunft</dt>
        <dd>{GEO_ORIGIN_LABELS[o.origin]}</dd>
        <dt>Externe IDs</dt>
        <dd>{externalIds.length === 0 ? "–" : externalIds.join(" · ")}</dd>
        {o.publicId && (
          <>
            <dt>Öffentliche ID</dt>
            <dd className="font-mono text-xs">{o.publicId}</dd>
          </>
        )}
        {o.configKey && (
          <>
            <dt>Konfiguration</dt>
            <dd>{o.configKey}</dd>
          </>
        )}
        <dt>Ort</dt>
        <dd>
          {detail.place ? (
            <>
              <Link href={`/places/${detail.place.id}`} className="underline">
                {PLACE_KIND_LABELS[detail.place.kind]}
              </Link>{" "}
              ({PLACE_STATUS_LABELS[detail.place.status]})
            </>
          ) : (
            "–"
          )}
        </dd>
        <dt>Kacheln</dt>
        <dd>
          {detail.tileIds.length === 0
            ? "–"
            : detail.tileIds.map((t, i) => (
                <span key={t}>
                  {i > 0 && ", "}
                  <Link href={`/tiles/${encodeURIComponent(t)}`} className="underline">
                    {t}
                  </Link>
                </span>
              ))}
        </dd>
        <dt>Gültig</dt>
        <dd>
          ab {o.validFrom}
          {o.validTo && ` bis ${o.validTo}`}
        </dd>
        {o.mergedIntoId && (
          <>
            <dt>Zusammengeführt in</dt>
            <dd>
              <Link href={`/geo/${o.mergedIntoId}`} className="font-mono text-xs underline">
                {o.mergedIntoId}
              </Link>
            </dd>
          </>
        )}
        <dt>Geo-Objekt</dt>
        <dd className="font-mono text-xs">{o.id}</dd>
      </dl>
      {!o.validTo && !o.mergedIntoId && (
        <form action={recomputeGeoProfileAction}>
          <input type="hidden" name="geoObjectId" value={o.id} />
          <button type="submit" className="rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-100">
            Profil neu berechnen
          </button>
        </form>
      )}

      <section>
        <h2 className="mb-1 font-semibold">Profil</h2>
        <ProfileTab
          view={profile}
          selected={selected}
          notice={textParam.parse(sp.notice)}
          noticeRunId={uuidParam.parse(sp.run)}
          links={{ geoObjectId: o.id, attrHref: (a) => href({ attr: a }) }}
        />
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Namen</h2>
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-neutral-300">
              <th className="py-1 pr-4">Name</th>
              <th className="pr-4">Sprache</th>
              <th className="pr-4">Schrift</th>
              <th className="pr-4">Herkunft</th>
              <th className="pr-4">Bevorzugt</th>
              <th>Gültig</th>
            </tr>
          </thead>
          <tbody>
            {detail.names.map((n) => (
              <tr
                key={`${n.name}|${n.language}|${n.origin}|${n.validFrom}`}
                className={`border-b border-neutral-200 ${n.valid ? "" : "text-neutral-500"}`}
              >
                <td className="py-1 pr-4">{n.name}</td>
                <td className="pr-4">{n.language}</td>
                <td className="pr-4">{SCRIPT_LABELS[n.script]}</td>
                <td className="pr-4">{NAME_ORIGIN_LABELS[n.origin]}</td>
                <td className="pr-4">{n.isPreferred ? "Ja" : "Nein"}</td>
                <td>{n.valid ? "Ja" : `Nein (bis ${n.validTo ?? "–"})`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Kinder</h2>
        {detail.children.length === 0 ? (
          <p>Keine Kinder.</p>
        ) : (
          <ul>
            {detail.children.map((c) => (
              <li key={c.id}>
                <GeoLink o={c} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Erwähnungen ({mentionPage.total})</h2>
        {mentionPage.rows.length === 0 ? (
          <p>Keine Erwähnungen.</p>
        ) : (
          <>
            <ul className="space-y-1">
              {mentionPage.rows.map((m) => (
                <li key={m.id} className="max-w-3xl">
                  <Link href={`/documents/${m.documentId}`} className="underline">
                    {m.domain}
                  </Link>{" "}
                  · {m.observedAt} · {MATCH_KIND_LABELS[m.matchKind]} ({share(m.confidence)}):{" "}
                  <span className="text-xs">
                    <AnnotatedText
                      text={m.snippet.before + m.snippet.quote + m.snippet.after}
                      spans={[{ start: m.snippet.before.length, end: m.snippet.before.length + m.snippet.quote.length, kind: "mention", ref: m.id }]}
                    />
                  </span>
                </li>
              ))}
            </ul>
            {pages > 1 && (
              <p className="mt-1 flex gap-3 text-xs">
                {page > 1 && (
                  <Link href={href({ mp: page - 1 })} className="underline">
                    ← zurück
                  </Link>
                )}
                <span>
                  Seite {page} von {pages}
                </span>
                {page < pages && (
                  <Link href={href({ mp: page + 1 })} className="underline">
                    weiter →
                  </Link>
                )}
              </p>
            )}
          </>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Facts</h2>
        <FactsTab groups={facts} runs={runs} runsHref={(r) => href({ runs: r })} />
      </section>
    </div>
  );
}
