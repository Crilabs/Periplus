"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { PlaceKind } from "@/lib/db/schema";
import type { ReviewDecision } from "@/lib/domain/review-decisions";
import { PLACE_KIND_LABELS } from "../../_components/labels";
import { MiniMap } from "../../_components/mini-map";
import { cx, inputClass, Panel } from "../../_components/ui";
import { DecisionForm } from "./decision-form";
import { DecisionPanel, MapLegend } from "./parts";

const KINDS = Object.keys(PLACE_KIND_LABELS) as PlaceKind[];

/**
 * Map of a place candidate plus its "confirm" decision: kind preselected, position correctable by a map click.
 * `children` are the task's further decisions, shown in the same decision block.
 */
export function PlaceConfirm({
  taskId,
  openedAt,
  defaultKind,
  features,
  open,
  question,
  children,
}: {
  taskId: string;
  openedAt: string;
  defaultKind: PlaceKind;
  features: GeoJSON.FeatureCollection;
  open: boolean;
  question?: ReactNode;
  children?: ReactNode;
}) {
  const [kind, setKind] = useState(defaultKind);
  const [position, setPosition] = useState<{ lon: number; lat: number } | null>(null);
  const shown = useMemo<GeoJSON.FeatureCollection>(
    () =>
      position
        ? {
            ...features,
            features: [
              ...features.features,
              {
                type: "Feature",
                geometry: {
                  type: "Point",
                  coordinates: [position.lon, position.lat],
                },
                properties: { role: "picked", label: "" },
              },
            ],
          }
        : features,
    [features, position],
  );
  const decision: ReviewDecision = {
    action: "confirm",
    kind,
    ...(position ? { position } : {}),
  };

  const map = (
    <Panel
      title="Karte"
      description={open ? "Ein Klick in die Karte setzt die Position, mit der „Bestätigen“ den Ort speichert." : undefined}
    >
      <MiniMap features={shown} onPick={open ? (lon, lat) => setPosition({ lon, lat }) : undefined} />
      <MapLegend
        items={[
          ["subject", "Dieser Ort"],
          ["nearby", "Orte in der Nähe"],
          ...(position ? [["picked", "Neue Position"] as ["picked", string]] : []),
        ]}
      />
    </Panel>
  );
  if (!open) return map;

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <DecisionPanel question={question} className="lg:col-span-2">
        <DecisionForm
          n={1}
          taskId={taskId}
          openedAt={openedAt}
          label="Bestätigen"
          decision={decision}
          variant="primary"
          hint="Bestätigt den Ort mit der gewählten Art und Position; ein Kandidat erhält dabei seine öffentliche ID."
        >
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Art</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as PlaceKind)} className={cx(inputClass, "h-8")}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {PLACE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <span className="flex w-full flex-wrap items-center gap-2 text-xs text-muted">
            {position
              ? `Neue Position ${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}`
              : "Position: Klick in die Karte korrigiert sie"}
            {position && (
              <button type="button" onClick={() => setPosition(null)} className="text-accent underline-offset-2 hover:underline">
                Zurücksetzen
              </button>
            )}
          </span>
        </DecisionForm>
        {children}
      </DecisionPanel>
      <div className="lg:col-span-3">{map}</div>
    </div>
  );
}
