"use client";

import { useMemo, useState } from "react";
import type { PlaceKind } from "@/lib/db/schema";
import type { ReviewDecision } from "@/lib/domain/review-decisions";
import { PLACE_KIND_LABELS } from "../../_components/labels";
import { MiniMap } from "../../_components/mini-map";
import { DecisionForm } from "./decision-form";

const KINDS = Object.keys(PLACE_KIND_LABELS) as PlaceKind[];

/** Map of a place candidate plus its "confirm" decision: kind preselected, position correctable by a map click. */
export function PlaceConfirm({
  taskId,
  openedAt,
  defaultKind,
  features,
  open,
}: {
  taskId: string;
  openedAt: string;
  defaultKind: PlaceKind;
  features: GeoJSON.FeatureCollection;
  open: boolean;
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

  return (
    <div className="space-y-2">
      <MiniMap features={shown} onPick={open ? (lon, lat) => setPosition({ lon, lat }) : undefined} />
      {open && (
        <DecisionForm n={1} taskId={taskId} openedAt={openedAt} label="Bestätigen" decision={decision}>
          <label className="flex items-center gap-1">
            Art
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as PlaceKind)}
              className="rounded border border-neutral-300 px-1 py-0.5"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {PLACE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <span className="text-neutral-600">
            {position
              ? `Neue Position ${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}`
              : "Position: Klick in die Karte korrigiert sie"}
          </span>
          {position && (
            <button type="button" onClick={() => setPosition(null)} className="underline">
              Zurücksetzen
            </button>
          )}
        </DecisionForm>
      )}
    </div>
  );
}
