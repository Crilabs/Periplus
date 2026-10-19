"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { MiniMap } from "../../_components/mini-map";
import { setAnchorAction, type SetAnchorResult } from "./actions";

/**
 * Map of the place geometry. When `editable`, a click proposes an anchor position (green) and the button
 * "Ankerposition übernehmen" sends it to `setAnchorAction`.
 */
export function AnchorMap({
  placeId,
  features,
  editable,
}: {
  placeId: string;
  features: GeoJSON.FeatureCollection;
  editable: boolean;
}) {
  const [picked, setPicked] = useState<{ lon: number; lat: number } | null>(null);
  const [result, setResult] = useState<SetAnchorResult | null>(null);
  const [pending, startTransition] = useTransition();
  const shown = useMemo<GeoJSON.FeatureCollection>(
    () =>
      picked
        ? {
            ...features,
            features: [
              ...features.features,
              { type: "Feature", geometry: { type: "Point", coordinates: [picked.lon, picked.lat] }, properties: { role: "picked" } },
            ],
          }
        : features,
    [features, picked],
  );

  const submit = () => {
    if (!picked) return;
    startTransition(async () => {
      const r = await setAnchorAction({ placeId, ...picked });
      setResult(r);
      if (r.ok) setPicked(null);
    });
  };

  return (
    <div className="space-y-2">
      <MiniMap
        features={shown}
        onPick={
          editable
            ? (lon, lat) => {
                setPicked({ lon, lat });
                setResult(null);
              }
            : undefined
        }
      />
      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-neutral-600">
            {picked
              ? `Vorschlag ${picked.lat.toFixed(5)}, ${picked.lon.toFixed(5)}`
              : "Klick in die Karte schlägt eine Ankerposition vor"}
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={!picked || pending}
            className="rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-100 disabled:opacity-50"
          >
            Ankerposition übernehmen
          </button>
          {picked && (
            <button type="button" onClick={() => setPicked(null)} className="underline">
              Zurücksetzen
            </button>
          )}
        </div>
      )}
      {result && (
        <p role={result.ok ? "status" : "alert"} className={result.ok ? "text-green-800" : "text-red-700"}>
          {result.ok ? result.message : result.error}
          {result.ok && result.runId && (
            <>
              {" "}
              <Link href={`/runs/${result.runId}`} className="underline">
                Lauf ansehen
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}
