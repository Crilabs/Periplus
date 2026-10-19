import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { geoFacts } from "@/lib/domain/geo-facts";
import { placeDetail } from "@/lib/domain/geo-view";
import { placeGeometry } from "@/lib/domain/geometry-view";
import { timelineView } from "@/lib/domain/profile-timeline";
import { profileAttributeFacts, profileView } from "@/lib/domain/profile-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { PLACE_KIND_LABELS, PLACE_STATUS_LABELS, REVIEW_KIND_LABELS, runScopeError } from "../../_components/labels";
import { recomputePlaceProfileAction } from "./actions";
import { FactsTab } from "./facts-tab";
import { GeometryTab } from "./geometry-tab";
import { ProfileTab } from "./profile-tab";
import { TimelineTab } from "./timeline-tab";

const time = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const coord = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

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
  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-lg font-semibold">{p.name ?? p.id}</h1>
      {error && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2">
          Lauf nicht gestartet: {error}
        </p>
      )}
      {task && (
        <p className="rounded bg-amber-100 px-3 py-2">
          Offene Prüfung:{" "}
          <Link href={`/review/${task.id}`} className="underline">
            {REVIEW_KIND_LABELS[task.kind]}
          </Link>
        </p>
      )}
      <nav aria-label="Reiter" className="flex gap-1 border-b border-neutral-300">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <Link
            key={t}
            href={t === "overview" ? `/places/${p.id}` : `/places/${p.id}?tab=${t}`}
            aria-current={t === tab ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-1 ${t === tab ? "border-neutral-800 font-semibold" : "border-transparent hover:border-neutral-400"}`}
          >
            {TABS[t]}
          </Link>
        ))}
      </nav>
      {tab === "profile" ? (
        <ProfileTabView placeId={p.id} geoObjectId={p.geoObjectId} version={versionParam.parse(sp.version)} attr={attr} notice={textParam.parse(sp.notice)} runId={uuidParam.parse(sp.run)} confirm={textParam.parse(sp.confirm)} />
      ) : tab === "timeline" ? (
        <TimelineTabView placeId={p.id} geoObjectId={p.geoObjectId} version={versionParam.parse(sp.v)} asOf={textParam.parse(sp.asOf)} attr={attr} confirm={textParam.parse(sp.confirm)} />
      ) : facts ? (
        <FactsTab groups={facts} runs={runs} runsHref={(r) => `/places/${p.id}?tab=facts${r === "all" ? "&runs=all" : ""}`} />
      ) : geometry ? (
        <GeometryTab
          placeId={p.id}
          position={p.position}
          view={geometry}
          editable={!p.validTo && !p.mergedIntoId}
        />
      ) : (
        <Overview detail={detail} />
      )}
    </div>
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
  return (
    <>
      <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
        <dt>Art</dt>
        <dd>{PLACE_KIND_LABELS[p.kind]}</dd>
        <dt>Status</dt>
        <dd>{PLACE_STATUS_LABELS[p.status]}</dd>
        <dt>Grund</dt>
        <dd>{p.statusReason ?? "–"}</dd>
        <dt>Position</dt>
        <dd>{coord(p.position.lat, p.position.lon)}</dd>
        <dt>Öffentliche ID</dt>
        <dd className="font-mono text-xs">{p.publicId ?? "–"}</dd>
        <dt>Kachel</dt>
        <dd>
          {p.tileId ? (
            <Link href={`/tiles/${encodeURIComponent(p.tileId)}`} className="underline">
              {p.tileId}
            </Link>
          ) : (
            "–"
          )}
        </dd>
        <dt>Geo-Objekt</dt>
        <dd>
          <Link href={`/geo/${p.geoObjectId}`} className="font-mono text-xs underline">
            {p.geoObjectId}
          </Link>
        </dd>
        {p.mergedIntoId && (
          <>
            <dt>Zusammengeführt in</dt>
            <dd>
              <Link href={`/places/${p.mergedIntoId}`} className="font-mono text-xs underline">
                {p.mergedIntoId}
              </Link>
            </dd>
          </>
        )}
        {p.validTo && (
          <>
            <dt>Gültig bis</dt>
            <dd>{p.validTo}</dd>
          </>
        )}
      </dl>
      {!p.validTo && !p.mergedIntoId && (
        <form action={recomputePlaceProfileAction}>
          <input type="hidden" name="placeId" value={p.id} />
          <button type="submit" className="rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-100">
            Profil neu berechnen
          </button>
        </form>
      )}

      <section>
        <h2 className="mb-1 font-semibold">Statusverlauf</h2>
        {detail.statusHistory.length === 0 ? (
          <p>Keine Statusänderungen.</p>
        ) : (
          <ul>
            {detail.statusHistory.map((h) => (
              <li key={h.changedAt.toISOString() + h.status}>
                {PLACE_STATUS_LABELS[h.status]} → geändert am {time(h.changedAt)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
