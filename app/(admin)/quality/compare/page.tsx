import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { SEABED_TYPE_LABELS } from "@/lib/domain/facts/labels";
import type { ComparisonAttribute } from "@/lib/domain/quality/comparison-values";
import { loadNavilyFromEnv } from "@/lib/domain/quality/navily-assistant";
import { areaComparisonView, isEvaluationRun, type PlaceComparison } from "@/lib/domain/quality/navily-compare";
import { navilySeabedTypes, type NavilySpot } from "@/lib/domain/quality/navily-sample";
import { createLogger } from "@/lib/logger";
import { requireAdmin } from "@/lib/security/require-admin";
import {
  COMPARISON_ATTRIBUTE_LABELS,
  COMPARISON_METHOD_LABELS,
  COMPARISON_RESULT_LABELS,
  PLACE_KIND_LABELS,
} from "../../_components/labels";
import {
  Badge,
  cx,
  EmptyState,
  FilterChips,
  fmt,
  Meter,
  Notice,
  PageHeader,
  Panel,
  Stat,
  Table,
  tdClass,
  thClass,
  trClass,
} from "../../_components/ui";
import { ComparePlace, type CompareRow } from "./compare-place";

export const metadata: Metadata = { title: "Vergleich mit Navily" };

const querySchema = z.object({
  area: z.string().optional().catch(undefined),
  place: z.uuid().optional().catch(undefined),
  filter: z.enum(["open", "all"]).default("open").catch("open"),
  /** Checked below: an id that is no evaluation run is a 404, never a page of empty values. */
  evaluation: z.string().optional().catch(undefined),
});

const metres = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km`);
const yesNo = (v: boolean | null) => (v === null ? "keine Angabe" : v ? "ja" : "nein");

/** The Navily side of one attribute, rendered at request time only (Grundprinzip 9). */
function navilyText(attribute: ComparisonAttribute, spot: NavilySpot | null, positionDistanceM: number | null): string {
  if (!spot) return attribute === "existence" ? "kein Spot zugeordnet" : "–";
  switch (attribute) {
    case "existence":
      return `Spot „${spot.name ?? "ohne Namen"}“`;
    case "position":
      return positionDistanceM === null ? "–" : `${metres(positionDistanceM)} entfernt`;
    case "depth":
      return "keine Tiefe bei Navily";
    case "seabed": {
      const types = [...new Set(navilySeabedTypes(spot.seabeds))];
      return types.length > 0 ? types.map((t) => SEABED_TYPE_LABELS[t]).join(", ") : "keine Angabe";
    }
    case "mooring.buoys":
      return spot.type === "buoy" ? "Bojenfeld" : "keine Angabe";
    case "services.water":
      return yesNo(spot.water);
    case "highlight.supply":
      return yesNo(spot.shop);
    case "highlight.food":
      return "keine Taverne bei Navily";
    default: {
      if (spot.prot === null) return "keine Angabe";
      const sector = attribute.slice("shelter.".length).toLowerCase();
      return spot.prot.some((p) => p.toLowerCase() === sector) ? "geschützt" : "offen";
    }
  }
}

function compareRows(p: PlaceComparison, withNavily: boolean): CompareRow[] {
  return p.rows.map((r) => ({
    attribute: r.attribute,
    label: COMPARISON_ATTRIBUTE_LABELS[r.attribute],
    own: r.value.display,
    navily: withNavily ? navilyText(r.attribute, p.spot, p.positionDistanceM) : null,
    proposal: r.proposal,
    stored: r.stored && {
      label: COMPARISON_RESULT_LABELS[r.stored.result],
      detail: `${COMPARISON_METHOD_LABELS[r.stored.method]}, ${r.stored.checkedBy}, ${fmt.dateTime(r.stored.checkedAt)}`,
      carried: r.stored.carried,
      tone: r.stored.result === "match" || r.stored.result === "deviation_confirmed_own" ? "ok" : r.stored.result === "not_at_navily" ? "neutral" : "warn",
    },
    valueHash: r.value.hash,
  }));
}

export default async function Page({ searchParams }: PageProps<"/quality/compare">) {
  await requireAdmin();
  // Navily values are read and rendered per request only: no prerendering, no cache (ruling M7-P23)
  await connection();
  const config = getConfig();
  const query = querySchema.parse(await searchParams);
  if (query.evaluation !== undefined && !(z.uuid().safeParse(query.evaluation).success && (await isEvaluationRun(getDb(), query.evaluation))))
    notFound();
  const area = config.areas.find((a) => a.key === query.area) ?? config.areas[0];
  const back = { href: "/quality", label: "Qualität" };
  if (!area)
    return (
      <>
        <PageHeader title="Vergleich mit Navily" back={back} />
        <Notice tone="warn">Kein Revier konfiguriert.</Notice>
      </>
    );

  let spots: NavilySpot[] | null = null;
  let navilyUnreadable = false;
  try {
    spots = await loadNavilyFromEnv();
  } catch (e) {
    // the message names the server's file path (never its content): server log only, not the page
    createLogger("quality-compare").warn({ reason: (e as Error).message }, "navily file unreadable");
    navilyUnreadable = true;
  }
  const view = await areaComparisonView(getDb(), {
    areaKey: area.key,
    evaluationRunId: query.evaluation,
    spots,
    cfg: config.quality.navily,
    affixes: config.nameAffixes,
  });
  const shown = query.filter === "open" ? view.places.filter((p) => p.open > 0) : view.places;
  const selected = view.places.find((p) => p.subject.placeId === query.place) ?? shown[0] ?? null;
  const href = (o: { place?: string; filter?: string; area?: string }) =>
    `/quality/compare?${new URLSearchParams({
      area: o.area ?? area.key,
      filter: o.filter ?? query.filter,
      ...(o.place ? { place: o.place } : {}),
      ...(query.evaluation ? { evaluation: query.evaluation } : {}),
    })}`;
  const placeName = (p: PlaceComparison) => p.subject.name ?? p.subject.publicId ?? p.subject.placeId;

  return (
    <>
      <PageHeader
        title="Vergleich mit Navily"
        back={back}
        description="Je Ort des Vergleichssatzes und Attribut ein Ergebnis: stimmt, weicht ab oder bei Navily nicht vorhanden. Gespeichert wird nur das Ergebnis, nie ein Navily-Wert; jede Abweichung wird eine Prüfaufgabe."
      />

      {config.areas.length > 1 && (
        <div className="mb-6">
          <FilterChips
            label="Revier"
            items={config.areas.map((a) => ({ href: href({ area: a.key }), label: a.names.de, current: a.key === area.key }))}
          />
        </div>
      )}

      <div className="mb-6 space-y-3">
        {navilyUnreadable ? (
          <Notice tone="danger" title="Navily-Datei nicht lesbar" data-testid="navily-status">
            Die Datei aus NAVILY_SPOTS_PATH fehlt oder ist keine gültige Spot-Liste. Details stehen im Server-Log. Vergleich nur von Hand.
          </Notice>
        ) : spots ? (
          <Notice tone="ok" data-testid="navily-status">
            Navily-Datei geladen: {fmt.int(spots.length)} Spots (nur zur Laufzeit, nichts wird gespeichert)
          </Notice>
        ) : (
          <Notice tone="warn" data-testid="navily-status">
            NAVILY_SPOTS_PATH nicht gesetzt – Vergleich nur von Hand
          </Notice>
        )}
        {query.evaluation && (
          <Notice tone="accent">
            Bewertungslauf <span className="font-mono">{query.evaluation}</span>: verglichen werden die Bewertungsprofile dieses Laufs.
          </Notice>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Vergleichssatz"
          value={
            <span className="tabular-nums" data-testid="compare-set-size">
              {view.places.length} von {config.quality.comparisonSet.pilotSize}
            </span>
          }
          hint={`Orte im Revier ${area.names.de}`}
          href={`/quality?area=${area.key}`}
        />
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3">
          <span className="text-xs text-muted">Fortschritt</span>
          <span className="text-2xl font-semibold tabular-nums tracking-tight">
            {fmt.int(view.checked)} / {fmt.int(view.total)}
          </span>
          <Meter ratio={view.total === 0 ? 0 : view.checked / view.total} label="Geprüfte Attribute" />
          <span className="text-xs text-muted">Geprüfte Attribute / alle</span>
        </div>
        <Stat
          label="Navily-Abdeckung"
          value={view.coverage?.ratio != null ? fmt.pct(view.coverage.ratio) : "–"}
          hint={
            view.coverage
              ? `${fmt.int(view.coverage.matched)} von ${fmt.int(view.coverage.spots)} Navily-Spots im Revier haben einen bestätigten Ort`
              : "Nur mit Navily-Datei"
          }
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Panel title="Orte" flush>
          <div className="border-b border-line px-4 py-3">
            <FilterChips
              label="Filter"
              items={[
                { href: href({ filter: "open" }), label: "Offen", current: query.filter === "open", count: view.places.filter((p) => p.open > 0).length },
                { href: href({ filter: "all" }), label: "Alle", current: query.filter === "all", count: view.places.length },
              ]}
            />
          </div>
          {shown.length === 0 ? (
            <EmptyState title={view.places.length === 0 ? "Vergleichssatz leer" : "Nichts offen"}>
              {view.places.length === 0 ? (
                <>
                  Orte werden auf der Seite{" "}
                  <Link href={`/quality?area=${area.key}`} className="text-accent hover:underline">
                    Qualität
                  </Link>{" "}
                  in den Vergleichssatz aufgenommen.
                </>
              ) : (
                "Jedes Attribut hat für seinen aktuellen Wert ein Ergebnis."
              )}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line" data-testid="compare-places">
              {shown.map((p) => (
                <li key={p.subject.placeId}>
                  <Link
                    href={href({ place: p.subject.placeId })}
                    aria-current={p.subject.placeId === selected?.subject.placeId ? "true" : undefined}
                    className={cx(
                      "flex items-center justify-between gap-2 px-4 py-2 text-sm hover:bg-sunken/50",
                      p.subject.placeId === selected?.subject.placeId && "bg-accent-soft font-medium",
                    )}
                  >
                    <span className="min-w-0 truncate">{placeName(p)}</span>
                    {p.open > 0 ? <Badge tone="warn">{p.open} offen</Badge> : <Badge tone="ok">geprüft</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {selected ? (
          <ComparePlace
            key={selected.subject.placeId}
            placeId={selected.subject.placeId}
            areaKey={area.key}
            evaluationRunId={query.evaluation}
            title={placeName(selected)}
            description={[
              PLACE_KIND_LABELS[selected.subject.kind],
              selected.subject.profileVersion !== null ? `Profilversion ${selected.subject.profileVersion}` : "Bewertungsprofil",
              spots
                ? selected.match?.spotIndex != null
                  ? `Navily-Spot in ${metres(selected.match.distanceM ?? 0)}, Namensähnlichkeit ${fmt.pct(selected.match.nameSimilarity ?? 0)}`
                  : "kein Navily-Spot zugeordnet"
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            rows={compareRows(selected, spots !== null)}
            digest={selected.digest}
          />
        ) : (
          <Panel title="Ort">
            <EmptyState title="Kein Ort gewählt">Links einen Ort wählen.</EmptyState>
          </Panel>
        )}
      </div>

      {spots && (
        <Panel
          title={`Navily-Orte ohne Periplus-Ort (${fmt.int(view.unmatchedSpots.length)})`}
          description="Navily-Spots im Revier, denen kein bestätigter Ort zugeordnet ist, mit dem Abstand zum nächsten Ort. Nur zur Laufzeit gelesen – wird nicht gespeichert."
          className="mt-6"
          flush
        >
          {view.unmatchedSpots.length === 0 ? (
            <EmptyState title="Keine">Jeder Navily-Spot im Revier hat einen bestätigten Ort.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={thClass}>Navily-Spot</th>
                  <th className={thClass}>Nächster Ort</th>
                  <th className={thClass}>Abstand</th>
                </tr>
              </thead>
              <tbody>
                {view.unmatchedSpots.map((u, i) => (
                  <tr key={i} className={trClass}>
                    <td className={tdClass}>{u.spot.name ?? "ohne Namen"}</td>
                    <td className={tdClass}>
                      {u.nearest ? (
                        <Link href={`/places/${u.nearest.placeId}`} className="text-accent hover:underline">
                          {u.nearest.name ?? u.nearest.placeId}
                        </Link>
                      ) : (
                        "–"
                      )}
                    </td>
                    <td className={cx(tdClass, "tabular-nums")}>{u.nearest ? metres(u.nearest.distanceM) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      )}
    </>
  );
}
