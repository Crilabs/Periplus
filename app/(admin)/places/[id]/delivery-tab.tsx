import type { Spot } from "@/contract";
import type { PlaceDelivery } from "@/lib/domain/delivery/view";
import { PREVIEW_OMISSION_LABELS } from "../../_components/labels";
import { Badge, DescriptionList, EmptyState, Mono, Notice, Panel, TextLink } from "../../_components/ui";

/** A contract object as JSON, formatted. */
function Json({ value, label }: { value: unknown; label: string }) {
  return (
    <pre aria-label={label} className="max-h-[36rem] overflow-auto rounded-md bg-sunken p-3 font-mono text-xs leading-relaxed">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

const TONE_LABELS = { positive: "positiv", negative: "negativ", neutral: "neutral" } as const;
const LANDING_LABELS = { harbour: "Hafen", pier: "Steg", slipway: "Slip", beach: "Strand", shore: "Ufer", text: "Beschreibung" } as const;
const ACCESS_LABELS = { foot: "zu Fuß", transport: "mit Transport" } as const;

/** What a spot of contract 4.0 says about the berth itself: facts, landing points, things on land, gaps. */
export function SpotDetails({ spot }: { spot: Omit<Spot, "asOf"> }) {
  const subjectOf = (f: Spot["facts"][number]) =>
    f.subject.kind === "spot" ? "Spot" : (spot.nearby.find((n) => n.id === (f.subject.kind === "landside" ? f.subject.id : null))?.name ?? (f.subject.kind === "landside" ? f.subject.name : null) ?? "An Land");
  return (
    <div className="space-y-4 text-sm">
      <section aria-label="Fakten">
        <h3 className="mb-1.5 text-xs font-medium text-muted">Fakten ({spot.facts.length})</h3>
        {spot.facts.length === 0 ? (
          <p className="text-muted">Keine Fakten.</p>
        ) : (
          <ul className="space-y-1.5">
            {spot.facts.map((f) => (
              <li key={f.id} className="rounded-md bg-sunken/60 px-2.5 py-1.5">
                <p className="flex flex-wrap items-center gap-1.5">
                  {f.safety && <Badge tone="danger">Sicherheit</Badge>}
                  {f.tone && <Badge tone={f.tone === "negative" ? "warn" : f.tone === "positive" ? "ok" : "neutral"}>{TONE_LABELS[f.tone]}</Badge>}
                  <span className="text-xs text-muted">
                    {subjectOf(f)}
                    {f.observedAt ? ` · ${f.observedAt}` : ""}
                    {f.mentions > 1 ? ` · ${f.mentions} Erwähnungen` : ""}
                  </span>
                </p>
                <p className="mt-1">{f.text}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Anlandepunkte">
        <h3 className="mb-1.5 text-xs font-medium text-muted">Anlandepunkte ({spot.landingPoints.length})</h3>
        {spot.landingPoints.length === 0 ? (
          <p className="text-muted">Keine Anlandepunkte.</p>
        ) : (
          <ul className="space-y-1">
            {spot.landingPoints.map((l, i) => (
              <li key={i}>
                {LANDING_LABELS[l.kind]}:{" "}
                {l.kind === "text" ? l.description : <span className="tabular-nums">{l.position.lat.toFixed(5)}, {l.position.lon.toFixed(5)}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="An Land">
        <h3 className="mb-1.5 text-xs font-medium text-muted">Dinge an Land ({spot.nearby.length})</h3>
        {spot.nearby.length === 0 ? (
          <p className="text-muted">Nichts an Land.</p>
        ) : (
          <ul className="space-y-1">
            {spot.nearby.map((n) => (
              <li key={n.id} className="flex flex-wrap justify-between gap-x-3">
                <span>
                  {n.name} <span className="text-xs text-muted">({n.category})</span>
                </span>
                <span className="tabular-nums text-muted">
                  {n.distanceM} m · {ACCESS_LABELS[n.access]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Lücken">
        <h3 className="mb-1.5 text-xs font-medium text-muted">Lücken ({spot.gaps.length})</h3>
        {spot.gaps.length === 0 ? <p className="text-muted">Keine Lücken.</p> : <p>{spot.gaps.join(", ")}</p>}
      </section>
    </div>
  );
}

/**
 * Tab „Lieferung“ of the place page (plan Task 14): the spot as last delivered (contract 4.0: facts, landing points,
 * things on land, gaps, then the JSON), the next package's spot when it differs, and every delivery of the spot.
 */
export function DeliveryTab({ view }: { view: PlaceDelivery }) {
  const { delivered, preview, history } = view;
  if (!delivered && !preview && history.length === 0) {
    return (
      <Panel>
        <EmptyState title="Keine Lieferung">
          Der Ort hat noch keine öffentliche ID. Er wird erst geliefert, wenn er bestätigt ist.
        </EmptyState>
      </Panel>
    );
  }
  const omission = preview && "omitted" in preview ? preview : null;
  const omitted = omission ? PREVIEW_OMISSION_LABELS[omission.omitted] : null;
  // a merged place whose target the package delivers is still in it, with `mergedInto` (ruling M6-P14)
  const carried = omission?.omitted === "merged";
  const next = preview && "spot" in preview ? preview : null;
  return (
    <div className="space-y-6">
      {next?.differs && (
        <Notice tone="warn" title="Nächstes Paket weicht ab">
          {delivered
            ? "Das nächste Paket des Reviers würde diesen Spot anders liefern als zuletzt geliefert. Die Vorschau zeigt ihn, wie „Paket bauen“ ihn jetzt bauen würde."
            : "Der Spot wurde noch nie geliefert; das nächste Paket des Reviers würde ihn neu liefern."}
        </Notice>
      )}
      {omitted && (
        <Notice
          tone={delivered && !carried ? "warn" : "neutral"}
          title={carried ? "Zusammengelegt" : delivered ? "Nicht mehr im nächsten Paket" : "Nicht im nächsten Paket"}
        >
          {omitted}
          {omission?.mergedInto && (
            <>
              {" "}
              Ziel: <Mono>{omission.mergedInto}</Mono>
            </>
          )}
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Panel
            title="Geliefert"
            description="Der Spot, wie ihn Abnehmer zuletzt bekommen haben (spots.json der Lieferung, die diese Version eingeführt hat)."
          >
            {delivered ? (
              <div className="space-y-4">
                <SpotDetails spot={delivered.spot} />
                <Json value={delivered.spot} label="Gelieferter Spot" />
              </div>
            ) : (
              <p className="text-sm text-muted">Noch nicht geliefert.</p>
            )}
          </Panel>
          {next?.differs && (
            <Panel title="Vorschau nächstes Paket" description="Der Spot, den der nächste Bau liefern würde (ohne Stand-Datum).">
              <div className="space-y-4">
                <SpotDetails spot={next.spot} />
                <Json value={next.spot} label="Vorschau des Spots" />
              </div>
            </Panel>
          )}
        </div>

        <div className="space-y-6">
          {delivered && (
            <Panel title="Gelieferter Stand">
              <DescriptionList
                columns={1}
                items={[
                  { label: "Stand des Platzes", value: delivered.spot.asOf ?? "–", hint: "Datum der Liegeplatz-Bestätigung, aus der der Spot gebaut wurde" },
                  { label: "Datenversion des Pakets", value: <span className="tabular-nums">{delivered.dataVersion}</span> },
                  { label: "Lieferung", value: <TextLink href={`/deliveries/${delivered.deliveryId}`}>Zur Lieferung</TextLink> },
                  { label: "Öffentliche ID", value: <Mono>{delivered.spot.id}</Mono> },
                ]}
              />
            </Panel>
          )}
          <Panel title="Lieferungen des Spots" flush>
            {history.length === 0 ? (
              <EmptyState title="Noch nicht geliefert" />
            ) : (
              <ol className="divide-y divide-line text-sm">
                {history.map((h) => (
                  <li key={`${h.profileVersion}-${h.deliveryId}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="flex items-center gap-2">
                      <span className="font-medium tabular-nums">Fassung {h.profileVersion}</span>
                      {h.removed && <Badge tone="neutral">Entfernt</Badge>}
                    </span>
                    <span className="flex items-center gap-3 text-xs text-muted">
                      <span>ab {h.validFrom}</span>
                      <TextLink href={`/deliveries/${h.deliveryId}`}>Lieferung</TextLink>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
