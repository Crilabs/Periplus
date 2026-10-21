import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { RunKind, RunStatus } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { subdivisionDetail } from "@/lib/domain/subdivisions/view";
import { requireAdmin } from "@/lib/security/require-admin";
import { RUN_KIND_LABELS, RUN_STATUS_LABELS, runScopeError } from "../../_components/labels";
import {
  Badge,
  Button,
  cx,
  DescriptionList,
  EmptyState,
  fmt,
  Mono,
  Notice,
  PageHeader,
  Panel,
  Table,
  tdClass,
  TextLink,
  thClass,
  trClass,
} from "../../_components/ui";
import { buildSubdivisionAction, startSubdivisionImagesAction } from "../actions";
import { SUBDIVISION_STATUS_TONES } from "../status";

export async function generateMetadata({ params }: PageProps<"/subdivisions/[key]">): Promise<Metadata> {
  return { title: `Landesteil ${decodeURIComponent((await params).key)}` };
}

export default async function Page({ params, searchParams }: PageProps<"/subdivisions/[key]">) {
  await requireAdmin();
  const key = decodeURIComponent((await params).key);
  const d = await subdivisionDetail(getDb(), key);
  if (!d) notFound();
  const error = runScopeError((await searchParams).error);
  const date = (iso: string | null) => fmt.dateTime(iso ? new Date(iso) : null);

  return (
    <>
      <PageHeader
        title={d.name}
        back={{ href: "/subdivisions", label: "Länder und Landesteile" }}
        meta={
          <>
            <Badge tone={SUBDIVISION_STATUS_TONES[d.status]} title={d.statusReason ?? undefined}>
              {d.status}
            </Badge>
            <span>{d.whole ? `${d.countryName} (als Ganzes)` : d.countryName}</span>
            <Mono>{d.key}</Mono>
            <Mono>{d.publicId}</Mono>
          </>
        }
        description={d.status === "ausgeschlossen" ? `Ausgeschlossen: ${d.statusReason ?? "ohne Grund"}` : undefined}
        actions={
          d.status !== "ausgeschlossen" && (
            <>
              {d.coreImagery && (
                <form action={startSubdivisionImagesAction}>
                  <input type="hidden" name="subdivisionKey" value={d.key} />
                  <Button title="Startet einen Lauf, der die Titelbilder der Orte dieses Landesteils erzeugt (höchstens so viele, wie die Konfiguration je Lauf erlaubt). Bilder, die schon erzeugt oder in Prüfung sind, werden übersprungen.">
                    Titelbilder erzeugen
                  </Button>
                </form>
              )}
              {d.status !== "läuft" && (
                <form action={buildSubdivisionAction}>
                  <input type="hidden" name="subdivisionKey" value={d.key} />
                  <Button variant="primary">Aufbauen</Button>
                </form>
              )}
            </>
          )
        }
      />
      {error && (
        <Notice tone="danger" className="mb-6">
          Lauf nicht gestartet: {error}
        </Notice>
      )}

      <Panel title="Kennzahlen" className="mb-6">
        <DescriptionList
          columns={3}
          items={[
            { label: "Küstenkacheln", value: fmt.int(d.coastTiles), hint: "Kacheln mit Küste, die das Label dieses Landesteils tragen" },
            { label: "davon bearbeitet", value: fmt.int(d.processedTiles) },
            { label: "Bestätigte Orte", value: fmt.int(d.counts.confirmedPlaces) },
            { label: "Kandidaten", value: fmt.int(d.counts.candidates) },
            { label: "Geo-Objekte", value: fmt.int(d.counts.geoObjects) },
            { label: "Kosten der Läufe", value: fmt.eur(d.costEur) },
            { label: "Letzter Lauf", value: date(d.lastRunAt) },
            { label: "Qualität", value: <TextLink href={`/quality?subdivision=${encodeURIComponent(d.key)}`}>Messungen ansehen</TextLink> },
          ]}
        />
      </Panel>

      <Panel title="Titelbilder" description="Abdeckung der Orte dieses Landesteils mit KI-Titelbildern (Spec 13)." className="mb-6">
        <DescriptionList
          columns={3}
          items={[
            { label: "Orte", value: fmt.int(d.images.spots), hint: "Bestätigte und ausgeschlossene Orte, die geliefert werden" },
            { label: "Mit Luftbild", value: fmt.int(d.images.withImagery), hint: "Orte unter einer Kachel des detaillierten Luftbilds (nicht leer)" },
            { label: "Mit freigegebenem Bild", value: fmt.int(d.images.withApprovedImage) },
            { label: "Lieferbar", value: fmt.int(d.images.deliverable), hint: "Freigegebenes Bild, dessen Quellen zur Lieferung freigegeben sind" },
            { label: "Median Wasser-IoU", value: d.images.medianWaterIoU === null ? "–" : d.images.medianWaterIoU.toLocaleString("de-DE", { maximumFractionDigits: 2 }) },
            { label: "Anteil abgelehnt", value: d.images.rejectedShare === null ? "–" : fmt.pct(d.images.rejectedShare), hint: "Entschiedene Bildprüfungen mit „Kein Bild“" },
            { label: "Kosten Luftbilder", value: fmt.eur(d.images.imageryCostEur), hint: "Kacheln, aus denen die Renderings dieser Orte entstanden" },
            { label: "Kosten Bilderzeugung", value: fmt.eur(d.images.generationCostEur), hint: "Aufrufe des Bildmodells für die Orte dieses Landesteils, aus jedem Lauf" },
          ]}
        />
      </Panel>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Kacheln" description="Küstenkacheln, die das Polygon des Landesteils schneiden (sein Laufumfang). „Label“: die Kachel trägt das Label dieses Landesteils; sonst das eines Nachbarn." flush>
          {d.tiles.length === 0 ? (
            <EmptyState title="Noch keine Kacheln">„Aufbauen“ legt die Kacheln mit dem Gazetteer an.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={thClass}>Kachel</th>
                  <th className={thClass}>Label</th>
                  <th className={thClass}>Letzter Lauf</th>
                </tr>
              </thead>
              <tbody>
                {d.tiles.map((t) => (
                  <tr key={t.id} className={trClass}>
                    <td className={tdClass}>
                      <TextLink href={`/tiles/${t.id}`} className="font-mono text-[0.8125rem]">
                        {t.id}
                      </TextLink>
                    </td>
                    <td className={tdClass}>{t.label ? "ja" : <span className="text-muted">Nachbar</span>}</td>
                    <td className={cx(tdClass, "whitespace-nowrap")}>{date(t.lastRunAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="Reviere" description="Reviere, die mit einer Kachel des Landesteils verknüpft sind (nur zur Information).">
          {d.areas.length === 0 ? (
            <p className="text-sm text-muted">Keine.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.areas.map((a) => (
                <li key={a.id}>
                  <TextLink href={`/geo/${a.id}`}>{a.name}</TextLink>
                  {a.publicId && (
                    <span className="ml-2 text-xs text-muted">
                      <Mono>{a.publicId}</Mono>
                    </span>
                  )}
                  <span className="ml-2 text-xs text-muted">
                    Schlüssel: {a.key ? <Mono>{a.key}</Mono> : "–"} · Mitglieder: {a.members}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Läufe" description="Die letzten 20 Läufe mit diesem Landesteil als Umfang." flush>
        {d.runs.length === 0 ? (
          <EmptyState title="Noch kein Lauf" />
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={thClass}>Lauf</th>
                <th className={thClass}>Art</th>
                <th className={thClass}>Stufen</th>
                <th className={thClass}>Status</th>
                <th className={thClass}>Gestartet</th>
                <th className={thClass}>Von</th>
              </tr>
            </thead>
            <tbody>
              {d.runs.map((r) => (
                <tr key={r.id} className={trClass}>
                  <td className={tdClass}>
                    <TextLink href={`/runs/${r.id}`} className="font-mono text-[0.8125rem]" title={r.id}>
                      {r.id.slice(0, 8)}
                    </TextLink>
                  </td>
                  <td className={tdClass}>{RUN_KIND_LABELS[r.kind as RunKind] ?? r.kind}</td>
                  <td className={cx(tdClass, "text-xs text-muted")}>{r.stages.length > 3 ? `${r.stages[0]} … ${r.stages.at(-1)} (${r.stages.length})` : r.stages.join(", ")}</td>
                  <td className={tdClass}>{RUN_STATUS_LABELS[r.status as RunStatus] ?? r.status}</td>
                  <td className={cx(tdClass, "whitespace-nowrap")}>{date(r.createdAt)}</td>
                  <td className={cx(tdClass, "text-xs text-muted")}>{r.triggeredBy}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
