import type { BerthLandingKind, BerthStateOrigin } from "@/lib/db/schema/research-state";
import type { BerthStateView } from "@/lib/domain/research/view";
import { TONE_LABELS } from "../../_components/labels";
import { Badge, EmptyState, fmt, Notice, Panel, Table, tdClass, thClass, trClass } from "../../_components/ui";

const ORIGIN_LABELS: Record<BerthStateOrigin, string> = { computed: "berechnet", text: "Text", rule: "Regel" };
const LANDING_LABELS: Record<BerthLandingKind, string> = {
  harbour: "Hafen",
  pier: "Steg",
  slipway: "Slip",
  beach: "Strand",
  shore: "Ufer",
  text: "Hinweis aus Text",
};
const ACCESS_LABELS = { foot: "zu Fuß", transport: "Bus/Taxi" } as const;

const coord = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
const de = (n: number, digits = 0) => n.toLocaleString("de-DE", { maximumFractionDigits: digits });

/**
 * Tab „Stand“ of the place page (plan N4a): the current picture of a confirmed berth. Core values with their origin
 * (berechnet, Text, Regel), the gaps, the bundled facts with date, tone, number of sources and the safety marker, the
 * landing points and what is reachable on land (category, distance, on foot or by bus/taxi).
 */
export function StateTab({ view }: { view: BerthStateView | null }) {
  if (!view) {
    return (
      <Panel>
        <EmptyState title="Noch kein Stand für diesen Liegeplatz.">Der Stand entsteht im Recherchelauf, sobald der Ort bestätigt ist.</EmptyState>
      </Panel>
    );
  }
  return (
    <div className="space-y-6">
      {view.status !== "confirmed" && (
        <Notice tone="warn" title="Nicht mehr bestätigt">
          Der Ort ist nicht mehr bestätigt: dieser Stand bleibt stehen, wird aber nicht geliefert und nicht mehr erneuert.
        </Notice>
      )}
      <p className="text-xs text-muted">Stand vom {fmt.dateTime(view.updatedAt)}</p>

      <Panel title="Kernwerte" flush>
        {view.core.length === 0 ? (
          <EmptyState title="Keine Kernwerte.">Weder berechnete Werte noch belegte Textwerte liegen vor.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={thClass}>Merkmal</th>
                <th className={thClass}>Wert</th>
                <th className={thClass}>Herkunft</th>
                <th className={thClass}>Konfidenz</th>
                <th className={thClass}>Beobachtet</th>
              </tr>
            </thead>
            <tbody>
              {view.core.map((c) => (
                <tr key={c.attribute} className={trClass}>
                  <td className={tdClass}>{c.label}</td>
                  <td className={tdClass}>{c.value}</td>
                  <td className={tdClass}>
                    <Badge tone={c.origin === "text" ? "accent" : "neutral"}>{ORIGIN_LABELS[c.origin]}</Badge>
                  </td>
                  <td className={tdClass}>{de(c.confidence, 2)}</td>
                  <td className={tdClass}>{c.observedAt ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel title="Lücken">
        {view.gaps.length === 0 ? (
          <p className="text-sm text-muted">Keine Lücken.</p>
        ) : (
          <ul className="flex flex-wrap gap-2" data-testid="state-gaps">
            {view.gaps.map((g) => (
              <li key={g.attribute}>
                <Badge tone="warn">{g.label}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Fakten" flush>
        {view.facts.length === 0 ? (
          <EmptyState title="Keine Fakten." />
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={thClass}>Aussage</th>
                <th className={thClass}>Gegenstand</th>
                <th className={thClass}>Datum</th>
                <th className={thClass}>Tonfall</th>
                <th className={thClass}>Quellen</th>
              </tr>
            </thead>
            <tbody>
              {view.facts.map((f) => (
                <tr key={f.factId} className={trClass}>
                  <td className={tdClass}>
                    {f.safety && (
                      <span className="mr-2">
                        <Badge tone="danger" title="Sicherheitshinweis">
                          Sicherheit
                        </Badge>
                      </span>
                    )}
                    {f.statement}
                  </td>
                  <td className={tdClass}>{f.subject === "berth" ? "Liegeplatz" : (f.subjectName ?? "an Land")}</td>
                  <td className={tdClass}>{f.observedAt}</td>
                  <td className={tdClass}>{f.tone ? TONE_LABELS[f.tone] : "–"}</td>
                  <td className={tdClass}>{f.mentions}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel title="Anlandestellen" flush>
        {view.landing.length === 0 ? (
          <EmptyState title="Keine Anlandestelle bekannt." />
        ) : (
          <ul className="divide-y divide-line text-sm">
            {view.landing.map((l, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3 px-4 py-2.5">
                <Badge>{LANDING_LABELS[l.kind]}</Badge>
                {l.description && <span>{l.description}</span>}
                {l.lat !== null && l.lon !== null && <span className="font-mono text-xs text-muted">{coord(l.lat, l.lon)}</span>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Erreichbar an Land" flush>
        {view.nearby.length === 0 ? (
          <EmptyState title="Nichts Erreichbares verzeichnet." />
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={thClass}>Kategorie</th>
                <th className={thClass}>Name</th>
                <th className={thClass}>Entfernung</th>
                <th className={thClass}>Zugang</th>
              </tr>
            </thead>
            <tbody>
              {view.nearby.map((n) => (
                <tr key={n.geoObjectId} className={trClass}>
                  <td className={tdClass}>{n.categoryLabel}</td>
                  <td className={tdClass}>{n.name ?? "–"}</td>
                  <td className={tdClass}>{fmt.int(n.distanceM)} m</td>
                  <td className={tdClass}>{ACCESS_LABELS[n.access]}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
