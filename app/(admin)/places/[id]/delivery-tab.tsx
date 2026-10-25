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

/**
 * Tab „Lieferung“ of the place page (plan Task 14): the spot as last delivered (contract JSON, version, `validFrom`,
 * the delivery), the next package's spot when it differs, and every contract version of the spot.
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
            {delivered ? <Json value={delivered.spot} label="Gelieferter Spot" /> : <p className="text-sm text-muted">Noch nicht geliefert.</p>}
          </Panel>
          {next?.differs && (
            <Panel title="Vorschau nächstes Paket" description="Der Spot, den der nächste Bau liefern würde (ohne Stand-Datum).">
              <Json value={next.spot} label="Vorschau des Spots" />
            </Panel>
          )}
        </div>

        <div className="space-y-6">
          {delivered && (
            <Panel title="Gelieferte Version">
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
          <Panel title="Versionen" flush>
            {history.length === 0 ? (
              <EmptyState title="Noch keine Version geliefert" />
            ) : (
              <ol className="divide-y divide-line text-sm">
                {history.map((h) => (
                  <li key={`${h.profileVersion}-${h.deliveryId}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="flex items-center gap-2">
                      <span className="font-medium tabular-nums">Version {h.profileVersion}</span>
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
