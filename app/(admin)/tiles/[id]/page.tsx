import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { tileDetail } from "@/lib/domain/geo-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { Dialog } from "../../_components/dialog";
import {
  GEO_OBJECT_TYPE_LABELS,
  PLACE_KIND_LABELS,
  PLACE_STATUS_LABELS,
  RUN_KIND_LABELS,
  runScopeError,
  SCOPE_TYPE_LABELS,
} from "../../_components/labels";
import { RunStatusBadge } from "../../_components/runs-table";
import {
  Badge,
  Button,
  cx,
  EmptyState,
  fmt,
  Mono,
  Notice,
  PageHeader,
  Panel,
  Stat,
  Table,
  tdClass,
  thClass,
  trClass,
} from "../../_components/ui";
import {
  consolidateTileAction,
  discoveryForTileAction,
  geometryTileAction,
  reprocessTileAction,
  seedTileAction,
  textRunTileAction,
} from "./actions";

/** The tab title: the tile id (UI-15). */
export async function generateMetadata({ params }: PageProps<"/tiles/[id]">): Promise<Metadata> {
  const id = tileIdParam((await params).id);
  return { title: id ? `Kachel ${id}` : "Kachel" };
}

const TILE_ID = /^q025:\d+:\d+$/;

/** Small amounts keep four decimals so cent fractions of single model calls stay visible. */
const eur = (n: number) => fmt.eur(n, n > 0 && n < 0.01 ? 4 : 2);

/** The tile id from the path; it may arrive URL-encoded (`q025%3A813%3A510`). Null when malformed. */
function tileIdParam(raw: string): string | null {
  try {
    const id = decodeURIComponent(raw);
    return TILE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The runs of the start dialog for one tile, in pipeline order. */
const TILE_RUNS: Array<{ name: string; description: string; action: (input: FormData) => Promise<void>; button: string }> = [
  {
    name: "Seed",
    description: "Legt aus Buchten, Häfen und Marinas der Kachel Ortskandidaten an.",
    action: seedTileAction,
    button: "Seed",
  },
  {
    name: "Geometrie",
    description:
      "Berechnet für die Orte der Kachel Fetch, Schutz je Sektor, Öffnung zur See und Schwell, danach Profil und Zusammenfassung. Braucht Tiefendaten und Landpolygone.",
    action: geometryTileAction,
    button: "Geometrie",
  },
  {
    name: "Quellenfindung",
    description: "Sucht in den Sprachen des Reviers nach Quellen zur Kachel und legt Quellenvorschläge zur Prüfung an.",
    action: discoveryForTileAction,
    button: "Quellenfindung",
  },
  {
    name: "Texte auswerten",
    description:
      "Wertet die Texte aus, die Objekte der Kachel erwähnen, dazu die noch offenen Versionen ihrer Quellen, und konsolidiert das Ergebnis.",
    action: textRunTileAction,
    button: "Texte auswerten",
  },
  {
    name: "Reprozessieren",
    description:
      "Extrahiert jede Erwähnung der Kachel erneut mit dem aktuell konfigurierten Modell, Prompt und Fact-Schema; die alten Facts bleiben.",
    action: reprocessTileAction,
    button: "Reprozessieren (Stufen 6–7)",
  },
  {
    name: "Konsolidieren",
    description:
      "Berechnet Profile und Zusammenfassungen der gültigen Objekte der Kachel aus den vorhandenen Facts neu und stößt für dünn belegte Orte eine gezielte Quellensuche an.",
    action: consolidateTileAction,
    button: "Konsolidieren",
  },
];

export default async function Page({ params, searchParams }: PageProps<"/tiles/[id]">) {
  await requireAdmin();
  const id = tileIdParam((await params).id);
  const error = runScopeError((await searchParams).error);
  if (!id) notFound();
  const detail = await tileDetail(getDb(), id);
  if (!detail) notFound();
  const { tile, subdivision } = detail;
  const subdivisionHref = subdivision ? `/subdivisions/${encodeURIComponent(subdivision.key)}` : null;
  const now = new Date();

  return (
    <>
      <PageHeader
        back={subdivision ? { href: subdivisionHref!, label: subdivision.name ?? subdivision.key } : { href: "/map", label: "Karte" }}
        title={
          <>
            Kachel <span className="font-mono">{tile.id}</span>
          </>
        }
        meta={
          <>
            <Badge tone={tile.hasCoast ? "accent" : "neutral"}>{tile.hasCoast ? "Küste" : "Ohne Küste"}</Badge>
            {tile.validTo && <Badge tone="warn">Gültig bis {tile.validTo}</Badge>}
            {subdivision ? (
              <span>
                Landesteil{" "}
                <Link href={subdivisionHref!} className="text-accent hover:underline">
                  {subdivision.name ?? subdivision.key}
                </Link>
              </span>
            ) : (
              <span>Keinem Landesteil zugeordnet</span>
            )}
          </>
        }
        description="Eine Kachel ist ein Rasterfeld von 0,25° × 0,25°. Läufe lassen sich für eine einzelne Kachel starten, etwa um einen Fehler gezielt nachzuverarbeiten."
        actions={
          <Dialog
            trigger="Lauf starten …"
            triggerVariant="primary"
            title="Lauf für diese Kachel starten"
            description="Jeder Lauf betrifft nur diese Kachel. Fehlt eine Voraussetzung, startet er nicht und die Seite sagt, was fehlt."
            wide
          >
            <ul className="divide-y divide-line">
              {TILE_RUNS.map((run) => (
                <li key={run.button} className="grid gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[1fr_auto] sm:items-center">
                  <div className="min-w-0">
                    <h3 className="font-medium">{run.name}</h3>
                    <p className="mt-0.5 leading-relaxed text-muted text-pretty">{run.description}</p>
                  </div>
                  <form action={run.action}>
                    <input type="hidden" name="tileId" value={tile.id} />
                    <Button type="submit" variant="primary">
                      {run.button}
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          </Dialog>
        }
      />

      {error && (
        <Notice tone="danger" title="Lauf nicht gestartet" className="mb-6">
          {error}.
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Letzter Lauf"
          value={fmt.ago(tile.lastRunAt, now)}
          hint={tile.lastRunAt ? fmt.dateTime(tile.lastRunAt) : "Noch kein Lauf"}
        />
        <Stat
          label="Nächster Lauf"
          value={tile.nextRunAt ? fmt.date(tile.nextRunAt) : "–"}
          hint={`Zyklus ${tile.cycleDays} Tage · Priorität ${tile.priority}`}
        />
        <Stat label="Orte" value={detail.places.length} hint={`${detail.geoObjects.length} Geo-Objekte in der Kachel`} />
        <Stat
          label="Kosten"
          value={eur(detail.costEur)}
          hint={
            detail.costs.length > 0
              ? detail.costs.map((c) => `${c.service}: ${fmt.int(c.calls)} Aufrufe, ${eur(c.costEur)}`).join(" · ")
              : "Noch keine externen Aufrufe"
          }
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Orte" description="Ankerplätze, Häfen und Marinas der Kachel mit ihrem Status." flush>
          {detail.places.length === 0 ? (
            <EmptyState title="Keine Orte">Ortskandidaten entstehen durch einen Seed-Lauf oder aus Texten.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {detail.places.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/places/${p.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-sunken/50"
                  >
                    <span className="min-w-0 truncate font-medium text-accent">{p.name ?? p.id}</span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
                      {PLACE_KIND_LABELS[p.kind]}
                      <Badge tone={p.status === "confirmed" ? "ok" : p.status === "candidate" ? "warn" : "neutral"}>
                        {PLACE_STATUS_LABELS[p.status]}
                      </Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Geo-Objekte" description="Inseln, Buchten, Kaps, Siedlungen und Highlights aus dem Gazetteer, die der Kachel zugeordnet sind." flush>
          {detail.geoObjects.length === 0 ? (
            <EmptyState title="Keine Geo-Objekte">Geo-Objekte entstehen durch den Gazetteer-Lauf des Reviers.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {detail.geoObjects.map((o) => (
                <li key={o.id}>
                  <Link
                    href={`/geo/${o.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-sunken/50"
                  >
                    <span className="min-w-0 truncate font-medium text-accent">{o.name ?? o.id}</span>
                    <span className="shrink-0 text-xs text-muted">{GEO_OBJECT_TYPE_LABELS[o.type]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Letzte Läufe" description="Läufe für diese Kachel oder mit ihr im Umfang, neueste zuerst." className="mt-6" flush>
        {detail.runs.length === 0 ? (
          <EmptyState title="Keine Läufe">Über „Lauf starten …“ lässt sich ein Lauf nur für diese Kachel starten.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={thClass}>Lauf</th>
                <th className={thClass}>Bereich</th>
                <th className={thClass}>Stufen</th>
                <th className={thClass}>Status</th>
                <th className={thClass}>Angelegt</th>
                <th className={thClass}>Beendet</th>
              </tr>
            </thead>
            <tbody>
              {detail.runs.map((r) => (
                <tr key={r.id} className={trClass}>
                  <td className={tdClass}>
                    <Link href={`/runs/${r.id}`} className="font-medium text-accent hover:underline">
                      {RUN_KIND_LABELS[r.kind]}
                    </Link>{" "}
                    <Mono title={r.id}>{r.id.slice(0, 8)}</Mono>
                  </td>
                  <td className={tdClass}>
                    {SCOPE_TYPE_LABELS[r.scopeType]} <Mono>{r.scopeId}</Mono>
                  </td>
                  <td className={cx(tdClass, "max-w-72")}>
                    <span className="line-clamp-2 font-mono text-xs text-muted" title={r.stages.join(", ")}>
                      {r.stages.join(", ")}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <RunStatusBadge status={r.status} />
                  </td>
                  <td className={cx(tdClass, "whitespace-nowrap")} title={fmt.dateTime(r.createdAt)}>
                    {fmt.ago(r.createdAt, now)}
                  </td>
                  <td className={cx(tdClass, "whitespace-nowrap")} title={fmt.dateTime(r.finishedAt)}>
                    {fmt.ago(r.finishedAt, now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
