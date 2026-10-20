import type { Metadata } from "next";
import { placeTitle } from "@/lib/domain/geo-view";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { PlaceStatus } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { deliveryArchive } from "@/lib/domain/delivery/archive";
import { placeDelivery } from "@/lib/domain/delivery/view";
import { geoFacts, geoMentions } from "@/lib/domain/geo-facts";
import { mergeCandidates, type MergeCandidate } from "@/lib/domain/place-merge";
import { ADMIN_PLACE_STATUSES } from "@/lib/domain/place-status";
import { placeDetail } from "@/lib/domain/geo-view";
import { placeGeometry } from "@/lib/domain/geometry-view";
import { placeImageView } from "@/lib/domain/images/view";
import { timelineView } from "@/lib/domain/profile-timeline";
import { profileAttributeFacts, profileView } from "@/lib/domain/profile-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { Dialog } from "../../_components/dialog";
import {
  mergeError,
  PLACE_KIND_LABELS,
  PLACE_STATUS_LABELS,
  placeStatusError,
  REVIEW_KIND_LABELS,
  runScopeError,
} from "../../_components/labels";
import { MentionsPanel } from "../../_components/mentions-panel";
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
import { mergePlaceAction, recomputePlaceProfileAction } from "./actions";
import { DeliveryTab } from "./delivery-tab";
import { FactsTab } from "./facts-tab";
import { GeometryTab } from "./geometry-tab";
import { ImageTab } from "./image-tab";
import { ProfileTab } from "./profile-tab";
import { StatusActions } from "./status-actions";
import { TimelineTab } from "./timeline-tab";

/** The tab title: the place's name (UI-15). */
export async function generateMetadata({ params }: PageProps<"/places/[id]">): Promise<Metadata> {
  await requireAdmin();
  return { title: (await placeTitle(getDb(), (await params).id)) ?? "Ort" };
}

const coord = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

const PLACE_STATUS_TONES: Record<PlaceStatus, Tone> = {
  candidate: "warn",
  confirmed: "ok",
  rejected: "neutral",
  abandoned: "neutral",
  no_anchoring: "danger",
};

/** Tabs of the place page (`?tab=`); later milestones add theirs. */
const TABS = {
  overview: "Übersicht",
  geometry: "Geometrie",
  facts: "Facts",
  profile: "Profil",
  image: "Titelbild",
  timeline: "Zeitachse",
  sources: "Quellen",
  delivery: "Lieferung",
} as const;
type Tab = keyof typeof TABS;
const tabParam = z.enum(Object.keys(TABS) as [Tab, ...Tab[]]).catch("overview");
const runsParam = z.enum(["active", "all"]).catch("active");
const versionParam = z.coerce.number().int().min(1).optional().catch(undefined);
const textParam = z.string().max(200).optional().catch(undefined);
const uuidParam = z.uuid().optional().catch(undefined);
const positionParam = z.enum(["moved", "moved_no_run", "too_far"]).optional().catch(undefined);
const statusParam = z.enum(ADMIN_PLACE_STATUSES).optional().catch(undefined);
const imageNoticeParam = z.enum(["removed", "changed"]).optional().catch(undefined);
const mentionPageParam = z.coerce.number().int().min(1).catch(1);

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
  const mergeable = active && p.status === "confirmed";
  const candidates = mergeable ? await mergeCandidates(db, p.id) : [];
  const merged = uuidParam.parse(sp.merged);
  const mergedRun = uuidParam.parse(sp.run);
  const mergeRefused = mergeError(sp.mergeError);
  const statusSet = statusParam.parse(sp.status);
  const statusRefused = placeStatusError(sp.statusError);
  const positionStatus = positionParam.parse(sp.position);
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
            <>
              {!task && <StatusActions placeId={p.id} status={p.status} />}
              {mergeable && <MergeDialog placeId={p.id} candidates={candidates} />}
              <form action={recomputePlaceProfileAction}>
                <input type="hidden" name="placeId" value={p.id} />
                <Button title="Startet einen Konsolidierungslauf für diesen Ort: das Profil wird aus den aktuellen Facts neu gebildet.">
                  Profil neu berechnen
                </Button>
              </form>
            </>
          )
        }
      />
      {merged && (
        <Notice tone={sp.mergedNoRun ? "warn" : "ok"} className="mb-6" title="Orte zusammengelegt">
          Der Ort <TextLink href={`/places/${merged}`}>{merged.slice(0, 8)}</TextLink> ist jetzt Teil dieses Orts; sein Profil
          bleibt als Verlauf. Liefert das nächste Paket seines Reviers auch diesen Ort, führt es ihn als „zusammengelegt in“
          diesen Ort; sonst (anderes Revier, oder dieser Ort wird nicht geliefert) meldet es ihn als entfernt.{" "}
          {sp.mergedNoRun ? (
            "Der Folgelauf konnte nicht gestartet werden – bitte „Profil neu berechnen“."
          ) : mergedRun ? (
            <>
              Das Profil wird neu berechnet (<TextLink href={`/runs/${mergedRun}`}>Lauf</TextLink>).
            </>
          ) : null}
        </Notice>
      )}
      {statusSet && (
        <Notice tone={sp.statusNoRun ? "warn" : "ok"} className="mb-6" title={`Status: ${PLACE_STATUS_LABELS[statusSet]}`}>
          {sp.statusNoRun ? (
            "Der Status ist gespeichert. Der Folgelauf konnte nicht gestartet werden – bitte „Profil neu berechnen“."
          ) : mergedRun ? (
            <>
              Gespeichert; das Profil wird neu berechnet (<TextLink href={`/runs/${mergedRun}`}>Lauf</TextLink>).
            </>
          ) : (
            "Gespeichert."
          )}
        </Notice>
      )}
      {statusRefused && (
        <Notice tone="danger" className="mb-6" title="Status nicht geändert">
          {statusRefused}
        </Notice>
      )}
      {mergeRefused && (
        <Notice tone="danger" className="mb-6" title="Nicht zusammengelegt">
          {mergeRefused}
        </Notice>
      )}
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
      ) : tab === "image" ? (
        <ImageTabView placeId={p.id} geoObjectId={p.geoObjectId} editable={active} notice={imageNoticeParam.parse(sp.imageNotice)} zoomRefused={sp.imageError === "zoom"} />
      ) : tab === "delivery" ? (
        <DeliveryTabView placeId={p.id} />
      ) : tab === "sources" ? (
        <SourcesTabView placeId={p.id} geoObjectId={p.geoObjectId} page={mentionPageParam.parse(sp.mp)} />
      ) : facts ? (
        <FactsTab groups={facts} runs={runs} runsHref={(r) => `/places/${p.id}?tab=facts${r === "all" ? "&runs=all" : ""}`} />
      ) : geometry ? (
        <GeometryTab
          placeId={p.id}
          position={p.position}
          view={geometry}
          editable={active}
          positionNotice={positionStatus ? { status: positionStatus, runId: uuidParam.parse(sp.run) } : undefined}
        />
      ) : (
        <Overview detail={detail} />
      )}
    </>
  );
}

/** „Quellen“: the documents that mention the place's object (spec 09), as on the geo page. */
async function SourcesTabView({ placeId, geoObjectId, page }: { placeId: string; geoObjectId: string; page: number }) {
  const mentions = await geoMentions(getDb(), geoObjectId, page);
  return (
    <MentionsPanel
      mentions={mentions}
      page={page}
      pageHref={(mp) => `/places/${placeId}?tab=sources${mp > 1 ? `&mp=${mp}` : ""}`}
    />
  );
}

async function ImageTabView({ placeId, geoObjectId, editable, notice, zoomRefused }: { placeId: string; geoObjectId: string; editable: boolean; notice?: "removed" | "changed"; zoomRefused: boolean }) {
  return <ImageTab placeId={placeId} view={await placeImageView(getDb(), geoObjectId)} editable={editable} notice={notice} zoomRefused={zoomRefused} />;
}

async function DeliveryTabView({ placeId }: { placeId: string }) {
  return <DeliveryTab view={await placeDelivery(getDb(), deliveryArchive(), placeId)} />;
}

/** „Mit Ort zusammenlegen“: choose a confirmed place nearby that this one becomes part of (ruling M6-P15). */
function MergeDialog({ placeId, candidates }: { placeId: string; candidates: MergeCandidate[] }) {
  return (
    <Dialog
      trigger="Mit Ort zusammenlegen"
      title="Mit Ort zusammenlegen"
      description="Für eine Dublette: dieser Ort wird verworfen und Teil des gewählten Orts. Namen, Kennungen und Facts gehen auf ihn über, sein Profil wird danach neu berechnet. Lässt sich nicht zurücknehmen."
      wide
    >
      {candidates.length === 0 ? (
        <EmptyState title="Kein bestätigter Ort in der Nähe" />
      ) : (
        <form action={mergePlaceAction} className="space-y-4">
          <input type="hidden" name="placeId" value={placeId} />
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm font-medium">Zusammenlegen mit</legend>
            {candidates.map((c, i) => (
              <label key={c.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-line px-3 py-2 hover:bg-sunken/50 has-checked:border-accent">
                <input type="radio" name="intoPlaceId" value={c.id} required defaultChecked={i === 0} className="mt-1 size-4 accent-accent" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{c.name ?? c.id.slice(0, 8)}</span>
                  <span className="ml-2 text-xs text-muted">{PLACE_KIND_LABELS[c.kind]}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
                    <span className="tabular-nums">{fmt.int(Math.round(c.distanceM))} m entfernt</span>
                    {c.publicId && <Mono>{c.publicId}</Mono>}
                    {c.sameSubdivision ? <span>{c.subdivisionName ?? "ohne Landesteil"}</span> : <Badge tone="warn">Anderer Landesteil: {c.subdivisionName ?? "ohne Landesteil"}</Badge>}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {candidates.some((c) => !c.sameSubdivision) && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="confirmAcrossSubdivisions" className="mt-0.5 size-4 accent-accent" />
              <span>Auch über Landesteilgrenzen zusammenlegen (nötig, wenn der gewählte Ort in einem anderen Landesteil liegt)</span>
            </label>
          )}
          <div className="flex justify-end">
            <Button variant="danger">Zusammenlegen</Button>
          </div>
        </form>
      )}
    </Dialog>
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
