import type { ReactNode } from "react";
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
import {
  Badge,
  Button,
  DescriptionList,
  EmptyState,
  Mono,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Table,
  tdClass,
  TextLink,
  thClass,
  trClass,
  cx,
} from "../../_components/ui";
import { Dialog } from "../../_components/dialog";
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
      <TextLink href={`/geo/${o.id}`}>{o.name ?? o.id.slice(0, 8)}</TextLink>{" "}
      <span className="text-xs text-muted">({GEO_OBJECT_TYPE_LABELS[o.type]})</span>
    </>
  );
}

function SectionHeading({ children, description }: { children: ReactNode; description?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-base font-semibold">{children}</h2>
      {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
    </div>
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
  const active = !o.validTo && !o.mergedIntoId;
  const shownNames = detail.names.filter((n) => n.valid);
  return (
    <>
      <PageHeader
        title={
          <>
            {o.name ?? o.id} <span className="font-normal text-muted">({GEO_OBJECT_TYPE_LABELS[o.type]})</span>
          </>
        }
        back={{ href: "/map", label: "Karte" }}
        meta={
          <>
            <Badge>{GEO_OBJECT_TYPE_LABELS[o.type]}</Badge>
            <Badge tone="neutral" title="Herkunft">
              {GEO_ORIGIN_LABELS[o.origin]}
            </Badge>
            {!active && <Badge tone="warn">{o.mergedIntoId ? "Zusammengeführt" : "Nicht mehr gültig"}</Badge>}
            {detail.place && (
              <TextLink href={`/places/${detail.place.id}`} className="text-sm">
                {PLACE_KIND_LABELS[detail.place.kind]} ({PLACE_STATUS_LABELS[detail.place.status]})
              </TextLink>
            )}
          </>
        }
        description="Ein Geo-Objekt mit Namen, Hierarchie, Erwähnungen in Dokumenten, den Facts daraus und dem Profil."
        actions={
          active && (
            <form action={recomputeGeoProfileAction}>
              <input type="hidden" name="geoObjectId" value={o.id} />
              <Button title="Startet einen Konsolidierungslauf für dieses Geo-Objekt: das Profil wird aus den aktuellen Facts neu gebildet.">
                Profil neu berechnen
              </Button>
            </form>
          )
        }
      />
      {error && (
        <Notice tone="danger" className="mb-6">
          Lauf nicht gestartet: {error}
        </Notice>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-10">
          <section>
            <SectionHeading>Profil</SectionHeading>
            <ProfileTab
              view={profile}
              selected={selected}
              notice={textParam.parse(sp.notice)}
              noticeRunId={uuidParam.parse(sp.run)}
              links={{ geoObjectId: o.id, confirm: textParam.parse(sp.confirm), attrHref: (a) => href({ attr: a }) }}
            />
          </section>

          <Panel
            title={`Erwähnungen (${mentionPage.total})`}
            description="Textstellen in Dokumenten, die diesem Geo-Objekt zugeordnet wurden."
            flush
          >
            {mentionPage.rows.length === 0 ? (
              <EmptyState title="Keine Erwähnungen.">
                Erwähnungen entstehen, wenn ein Lauf ein Dokument liest, das dieses Geo-Objekt nennt.
              </EmptyState>
            ) : (
              <>
                <ul className="divide-y divide-line">
                  {mentionPage.rows.map((m) => (
                    <li key={m.id} className="space-y-1 px-4 py-3 text-sm">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                        <TextLink href={`/documents/${m.documentId}`} className="text-sm">
                          {m.domain}
                        </TextLink>
                        <span>{m.observedAt}</span>
                        <Badge>
                          {MATCH_KIND_LABELS[m.matchKind]} {share(m.confidence)}
                        </Badge>
                      </p>
                      <p className="max-w-3xl text-xs leading-relaxed text-muted">
                        <AnnotatedText
                          text={m.snippet.before + m.snippet.quote + m.snippet.after}
                          spans={[{ start: m.snippet.before.length, end: m.snippet.before.length + m.snippet.quote.length, kind: "mention", ref: m.id }]}
                        />
                      </p>
                    </li>
                  ))}
                </ul>
                {pages > 1 && (
                  <div className="border-t border-line">
                    <Pagination page={page} pages={pages} total={mentionPage.total} noun="Erwähnungen" href={(mp) => href({ mp })} />
                  </div>
                )}
              </>
            )}
          </Panel>

          <section>
            <SectionHeading>Facts</SectionHeading>
            <FactsTab groups={facts} runs={runs} runsHref={(r) => href({ runs: r })} />
          </section>
        </div>

        <div className="space-y-6">
          <Panel title="Eckdaten">
            <DescriptionList
              columns={1}
              items={[
                {
                  label: "Eltern-Kette",
                  value:
                    detail.ancestors.length === 0
                      ? "–"
                      : detail.ancestors.map((a, i) => (
                          <span key={a.id}>
                            {i > 0 && " → "}
                            <GeoLink o={a} />
                          </span>
                        )),
                },
                {
                  label: "Ort",
                  value: detail.place ? (
                    <>
                      <TextLink href={`/places/${detail.place.id}`}>{PLACE_KIND_LABELS[detail.place.kind]}</TextLink>{" "}
                      <span className="text-muted">({PLACE_STATUS_LABELS[detail.place.status]})</span>
                    </>
                  ) : (
                    "–"
                  ),
                },
                {
                  label: "Kacheln",
                  value:
                    detail.tileIds.length === 0
                      ? "–"
                      : detail.tileIds.map((t, i) => (
                          <span key={t}>
                            {i > 0 && ", "}
                            <TextLink href={`/tiles/${encodeURIComponent(t)}`}>{t}</TextLink>
                          </span>
                        )),
                },
                {
                  label: "Gültig",
                  value: (
                    <>
                      ab {o.validFrom}
                      {o.validTo && ` bis ${o.validTo}`}
                    </>
                  ),
                },
                o.mergedIntoId && {
                  label: "Zusammengeführt in",
                  value: (
                    <TextLink href={`/geo/${o.mergedIntoId}`} title={o.mergedIntoId} className="font-mono text-[0.8125rem]">
                      {o.mergedIntoId.slice(0, 8)}
                    </TextLink>
                  ),
                },
                { label: "Externe IDs", value: externalIds.length === 0 ? "–" : <Mono>{externalIds.join(" · ")}</Mono> },
                o.publicId && { label: "Öffentliche ID", value: <Mono>{o.publicId}</Mono> },
                o.configKey && { label: "Konfiguration", value: <Mono>{o.configKey}</Mono> },
                { label: "Geo-Objekt", value: <Mono>{o.id}</Mono> },
              ]}
            />
          </Panel>

          <Panel
            title="Namen"
            description="Die heute gültigen Namen; frühere stehen unter „Alle Namen“."
            actions={
              <Dialog trigger="Alle Namen" triggerSize="sm" title="Namen" description="Alle Namen mit Sprache, Schrift, Herkunft und Gültigkeit." wide>
                <Table>
                  <thead>
                    <tr>
                      <th className={thClass}>Name</th>
                      <th className={thClass}>Sprache</th>
                      <th className={thClass}>Schrift</th>
                      <th className={thClass}>Herkunft</th>
                      <th className={thClass}>Bevorzugt</th>
                      <th className={thClass}>Gültig</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.names.map((n) => (
                      <tr key={`${n.name}|${n.language}|${n.origin}|${n.validFrom}`} className={cx(trClass, !n.valid && "text-muted")}>
                        <td className={tdClass}>{n.name}</td>
                        <td className={tdClass}>{n.language}</td>
                        <td className={tdClass}>{SCRIPT_LABELS[n.script]}</td>
                        <td className={tdClass}>{NAME_ORIGIN_LABELS[n.origin]}</td>
                        <td className={tdClass}>{n.isPreferred ? "Ja" : "Nein"}</td>
                        <td className={tdClass}>{n.valid ? "Ja" : `Nein (bis ${n.validTo ?? "–"})`}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Dialog>
            }
            flush
          >
            {shownNames.length === 0 ? (
              <EmptyState title="Keine gültigen Namen." />
            ) : (
              <ul className="divide-y divide-line text-sm">
                {shownNames.map((n) => (
                  <li key={`${n.name}|${n.language}|${n.origin}|${n.validFrom}`} className="flex items-center justify-between gap-3 px-4 py-2">
                    <span className="min-w-0 break-words">
                      {n.name} <span className="text-xs text-muted">{n.language}</span>
                    </span>
                    {n.isPreferred && <Badge tone="accent">bevorzugt</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Kinder" description="Geo-Objekte, die zu diesem gehören." flush>
            {detail.children.length === 0 ? (
              <EmptyState title="Keine Kinder." />
            ) : (
              <ul className="max-h-96 divide-y divide-line overflow-y-auto text-sm">
                {detail.children.map((c) => (
                  <li key={c.id} className="px-4 py-2">
                    <GeoLink o={c} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
