import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { PlaceStatus } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { geoFacts } from "@/lib/domain/geo-facts";
import { placeDetail } from "@/lib/domain/geo-view";
import { placeGeometry } from "@/lib/domain/geometry-view";
import { timelineView } from "@/lib/domain/profile-timeline";
import { profileAttributeFacts, profileView } from "@/lib/domain/profile-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { PLACE_KIND_LABELS, PLACE_STATUS_LABELS, REVIEW_KIND_LABELS, runScopeError } from "../../_components/labels";
import { MiniMap } from "../../_components/mini-map";
import {
  Badge,
  Button,
  DescriptionList,
  EmptyState,
  fmt,
  Mono,
  Notice,
  PageHeader,
  Panel,
  TabNav,
  TextLink,
  type Tone,
} from "../../_components/ui";
import { recomputePlaceProfileAction } from "./actions";
import { FactsTab } from "./facts-tab";
import { GeometryTab } from "./geometry-tab";
import { ProfileTab } from "./profile-tab";
import { TimelineTab } from "./timeline-tab";

const coord = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

const PLACE_STATUS_TONES: Record<PlaceStatus, Tone> = {
  candidate: "warn",
  confirmed: "ok",
  rejected: "neutral",
  abandoned: "neutral",
  no_anchoring: "danger",
};

/** Tabs of the place page (`?tab=`); later milestones add theirs. */
const TABS = { overview: "Übersicht", geometry: "Geometrie", facts: "Facts", profile: "Profil", timeline: "Zeitachse" } as const;
type Tab = keyof typeof TABS;
const tabParam = z.enum(Object.keys(TABS) as [Tab, ...Tab[]]).catch("overview");
const runsParam = z.enum(["active", "all"]).catch("active");
const versionParam = z.coerce.number().int().min(1).optional().catch(undefined);
const textParam = z.string().max(200).optional().catch(undefined);
const uuidParam = z.uuid().optional().catch(undefined);

type Detail = NonNullable<Awaited<ReturnType<typeof placeDetail>>>;

export default async function Page({ params, searchParams }: PageProps<"/places/[id]">) {
  await requireAdmin();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const sp = await searchParams;
  const tab = tabParam.parse(sp.tab);
  const runs = runsParam.parse(sp.runs);
  const error = runScopeError(sp.error);
  const db = getDb();
  const detail = await placeDetail(db, id.data);
  if (!detail) notFound();
  const { place: p, openReviewTask: task } = detail;
  const geometry = tab === "geometry" ? await placeGeometry(db, p.id) : null;
  const facts = tab === "facts" ? await geoFacts(db, p.geoObjectId, { runs }) : null;
  const attr = textParam.parse(sp.attr);
  const active = !p.validTo && !p.mergedIntoId;
  return (
    <>
      <PageHeader
        title={p.name ?? p.id}
        back={p.tileId ? { href: `/tiles/${encodeURIComponent(p.tileId)}`, label: `Kachel ${p.tileId}` } : { href: "/map", label: "Karte" }}
        meta={
          <>
            <Badge>{PLACE_KIND_LABELS[p.kind]}</Badge>
            <Badge tone={PLACE_STATUS_TONES[p.status]} title={p.statusReason ?? undefined}>
              {PLACE_STATUS_LABELS[p.status]}
            </Badge>
            {!active && <Badge tone="neutral">{p.mergedIntoId ? "Zusammengeführt" : "Nicht mehr gültig"}</Badge>}
            <Mono title="Breite, Länge (WGS84)">{coord(p.position.lat, p.position.lon)}</Mono>
            {task && (
              <Link
                href={`/review/${task.id}`}
                className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn ring-1 ring-warn/25 ring-inset hover:brightness-95"
              >
                Offene Prüfung: {REVIEW_KIND_LABELS[task.kind]}
              </Link>
            )}
          </>
        }
        description="Ein Ankerplatz mit seinem Profil, den Facts, aus denen es entsteht, und der berechneten Geometrie."
        actions={
          active && (
            <form action={recomputePlaceProfileAction}>
              <input type="hidden" name="placeId" value={p.id} />
              <Button title="Startet einen Konsolidierungslauf für diesen Ort: das Profil wird aus den aktuellen Facts neu gebildet.">
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
      <TabNav
        items={(Object.keys(TABS) as Tab[]).map((t) => ({
          href: t === "overview" ? `/places/${p.id}` : `/places/${p.id}?tab=${t}`,
          label: TABS[t],
          current: t === tab,
        }))}
      />
      {tab === "profile" ? (
        <ProfileTabView placeId={p.id} geoObjectId={p.geoObjectId} version={versionParam.parse(sp.version)} attr={attr} notice={textParam.parse(sp.notice)} runId={uuidParam.parse(sp.run)} confirm={textParam.parse(sp.confirm)} />
      ) : tab === "timeline" ? (
        <TimelineTabView placeId={p.id} geoObjectId={p.geoObjectId} version={versionParam.parse(sp.v)} asOf={textParam.parse(sp.asOf)} attr={attr} confirm={textParam.parse(sp.confirm)} />
      ) : facts ? (
        <FactsTab groups={facts} runs={runs} runsHref={(r) => `/places/${p.id}?tab=facts${r === "all" ? "&runs=all" : ""}`} />
      ) : geometry ? (
        <GeometryTab placeId={p.id} position={p.position} view={geometry} editable={active} />
      ) : (
        <Overview detail={detail} />
      )}
    </>
  );
}

type ProfileTabProps = { placeId: string; geoObjectId: string; version: number | undefined; attr: string | undefined };

async function ProfileTabView({ placeId, geoObjectId, version, attr, notice, runId, confirm }: ProfileTabProps & { notice?: string; runId?: string; confirm?: string }) {
  const db = getDb();
  const view = await profileView(db, geoObjectId, { version });
  const selected = view && attr ? await profileAttributeFacts(db, geoObjectId, view.snapshot.version, attr) : null;
  const base = `/places/${placeId}?tab=profile${version !== undefined ? `&version=${version}` : ""}`;
  return (
    <ProfileTab
      view={view}
      selected={selected}
      notice={notice}
      noticeRunId={runId}
      links={{ geoObjectId, placeId, confirm, attrHref: (a) => (a ? `${base}&attr=${encodeURIComponent(a)}` : base) }}
    />
  );
}

async function TimelineTabView({ placeId, geoObjectId, version, asOf, attr, confirm }: ProfileTabProps & { asOf: string | undefined; confirm?: string }) {
  const db = getDb();
  const t = await timelineView(db, geoObjectId, { version, asOf });
  const selected = t.view && attr ? await profileAttributeFacts(db, geoObjectId, t.view.snapshot.version, attr) : null;
  const baseHref = `/places/${placeId}?tab=timeline`;
  const shown = t.asOf ? `&asOf=${t.asOf}` : t.view ? `&v=${t.view.snapshot.version}` : "";
  return (
    <TimelineTab
      placeId={placeId}
      baseHref={baseHref}
      versions={t.versions}
      events={t.events}
      view={t.view}
      selected={selected}
      diff={t.diff}
      diffNotes={t.diffNotes}
      asOf={t.asOf}
      asOfInvalid={t.asOfInvalid}
      links={{ geoObjectId, placeId, confirm, attrHref: (a) => `${baseHref}${shown}${a ? `&attr=${encodeURIComponent(a)}` : ""}` }}
    />
  );
}

function Overview({ detail }: { detail: Detail }) {
  const p = detail.place;
  const point: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: [p.position.lon, p.position.lat] }, properties: { role: "subject" } }],
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Panel flush className="overflow-hidden [&_[aria-label=Kartenausschnitt]]:h-[24rem] lg:[&_[aria-label=Kartenausschnitt]]:h-[32rem]">
        <MiniMap features={point} />
      </Panel>

      <div className="space-y-6">
        <Panel title="Eckdaten">
          <DescriptionList
            columns={1}
            items={[
              { label: "Statusgrund", value: p.statusReason ?? "–", hint: "Warum der Ort diesen Status hat" },
              { label: "Position", value: <Mono>{coord(p.position.lat, p.position.lon)}</Mono> },
              {
                label: "Öffentliche ID",
                value: p.publicId ? <Mono>{p.publicId}</Mono> : "–",
                hint: "Kennung, unter der der Ort geliefert wird",
              },
              {
                label: "Kachel",
                value: p.tileId ? <TextLink href={`/tiles/${encodeURIComponent(p.tileId)}`}>{p.tileId}</TextLink> : "–",
              },
              {
                label: "Geo-Objekt",
                value: (
                  <TextLink href={`/geo/${p.geoObjectId}`} title={p.geoObjectId} className="font-mono text-[0.8125rem]">
                    {p.geoObjectId.slice(0, 8)}
                  </TextLink>
                ),
                hint: "Namen, Erwähnungen und Hierarchie des Orts",
              },
              p.mergedIntoId && {
                label: "Zusammengeführt in",
                value: (
                  <TextLink href={`/places/${p.mergedIntoId}`} title={p.mergedIntoId} className="font-mono text-[0.8125rem]">
                    {p.mergedIntoId.slice(0, 8)}
                  </TextLink>
                ),
              },
              p.validTo && { label: "Gültig bis", value: p.validTo },
            ]}
          />
        </Panel>

        <Panel title="Statusverlauf" flush>
          {detail.statusHistory.length === 0 ? (
            <EmptyState title="Keine Statusänderungen.">Der Ort hat seinen Status seit der Anlage behalten.</EmptyState>
          ) : (
            <ol className="divide-y divide-line text-sm">
              {detail.statusHistory.map((h) => (
                <li key={h.changedAt.toISOString() + h.status} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <Badge tone={PLACE_STATUS_TONES[h.status]}>{PLACE_STATUS_LABELS[h.status]}</Badge>
                  <span className="text-xs text-muted" title={fmt.dateTime(h.changedAt)}>
                    {fmt.dateTime(h.changedAt)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </div>
  );
}
