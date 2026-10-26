import type { Metadata } from "next";
import { placeTitle } from "@/lib/domain/geo-view";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { PlaceStatus } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { deliveryArchive } from "@/lib/domain/delivery/archive";
import { placeDelivery } from "@/lib/domain/delivery/view";
import { mergeCandidates, type MergeCandidate } from "@/lib/domain/place-merge";
import { ADMIN_PLACE_STATUSES } from "@/lib/domain/place-status";
import { placeDetail } from "@/lib/domain/geo-view";
import { placeGeometry } from "@/lib/domain/geometry-view";
import { berthStateView, researchView } from "@/lib/domain/research/view";
import { placeImageView } from "@/lib/domain/images/view";
import { requireAdmin } from "@/lib/security/require-admin";
import { Dialog } from "../../_components/dialog";
import {
  mergeError,
  PLACE_KIND_LABELS,
  PLACE_STATUS_LABELS,
  placeStatusError,
  REVIEW_KIND_LABELS,
  runScopeError,
  WEBSITE_ORIGIN_LABELS,
} from "../../_components/labels";
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
import { mergePlaceAction } from "./actions";
import { DeliveryTab } from "./delivery-tab";
import { GeometryTab } from "./geometry-tab";
import { ImageTab } from "./image-tab";
import { ResearchTab } from "./research-tab";
import { StateTab } from "./state-tab";
import { StatusActions } from "./status-actions";

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
  research: "Recherche",
  state: "Stand",
  image: "Bilder",
  delivery: "Lieferung",
} as const;
type Tab = keyof typeof TABS;
const tabParam = z.enum(Object.keys(TABS) as [Tab, ...Tab[]]).catch("overview");
const uuidParam = z.uuid().optional().catch(undefined);
const positionParam = z.enum(["moved", "moved_no_run", "too_far"]).optional().catch(undefined);
const statusParam = z.enum(ADMIN_PLACE_STATUSES).optional().catch(undefined);
const imageNoticeParam = z.enum(["removed", "changed"]).optional().catch(undefined);

type Detail = NonNullable<Awaited<ReturnType<typeof placeDetail>>>;

export default async function Page({ params, searchParams }: PageProps<"/places/[id]">) {
  await requireAdmin();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const sp = await searchParams;
  const tab = tabParam.parse(sp.tab);
  const error = runScopeError(sp.error);
  const db = getDb();
  const detail = await placeDetail(db, id.data);
  if (!detail) notFound();
  const { place: p, openReviewTask: task } = detail;
  const geometry = tab === "geometry" ? await placeGeometry(db, p.id) : null;
  const active = !p.validTo && !p.mergedIntoId;
  const mergeable = active && p.status === "confirmed";
  const candidates = mergeable ? await mergeCandidates(db, p.id) : [];
  const merged = uuidParam.parse(sp.merged);
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
        description="Ein Ankerplatz mit seinem Stand, der Recherche, der berechneten Geometrie und den Bildern."
        actions={
          active && (
            <>
              {!task && <StatusActions placeId={p.id} status={p.status} />}
              {mergeable && <MergeDialog placeId={p.id} candidates={candidates} />}
            </>
          )
        }
      />
      {merged && (
        <Notice tone="ok" className="mb-6" title="Orte zusammengelegt">
          Der Ort <TextLink href={`/places/${merged}`}>{merged.slice(0, 8)}</TextLink> ist jetzt Teil dieses Orts; sein Stand
          bleibt als Verlauf. Liefert das nächste Paket seines Reviers auch diesen Ort, führt es ihn als „zusammengelegt in“
          diesen Ort; sonst (anderes Revier, oder dieser Ort wird nicht geliefert) meldet es ihn als entfernt.
        </Notice>
      )}
      {statusSet && (
        <Notice tone="ok" className="mb-6" title={`Status: ${PLACE_STATUS_LABELS[statusSet]}`}>
          Gespeichert.
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
      {tab === "image" ? (
        <ImageTabView placeId={p.id} geoObjectId={p.geoObjectId} editable={active} notice={imageNoticeParam.parse(sp.imageNotice)} zoomRefused={sp.imageError === "zoom"} />
      ) : tab === "research" ? (
        <ResearchTab view={await researchView(db, p.id)} />
      ) : tab === "state" ? (
        <StateTab view={await berthStateView(db, p.id)} />
      ) : tab === "delivery" ? (
        <DeliveryTabView placeId={p.id} />
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
      description="Für eine Dublette: dieser Ort wird verworfen und Teil des gewählten Orts. Namen und Kennungen gehen auf ihn über. Lässt sich nicht zurücknehmen."
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
              {
                label: "Festmachplatz",
                value: detail.berthable === null ? "unbekannt" : detail.berthable ? "ja" : "nein",
                hint: "Ob man hier festmachen kann: aus Ortsart und Status abgeleitet",
              },
              {
                label: "Website",
                value: detail.website ? (
                  <span>
                    <a href={detail.website.url} target="_blank" rel="noreferrer noopener" className="break-all text-accent hover:underline">
                      {detail.website.url}
                    </a>{" "}
                    <span className="text-xs text-muted">
                      ({WEBSITE_ORIGIN_LABELS[detail.website.origin]}
                      {detail.website.bound ? ", als Quelle gebunden" : ""})
                    </span>
                  </span>
                ) : (
                  "–"
                ),
              },
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
                hint: "Namen und Hierarchie des Orts",
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
      </div>
    </div>
  );
}
