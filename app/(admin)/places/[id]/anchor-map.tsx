"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { MiniMap } from "../../_components/mini-map";
import { Button, cx } from "../../_components/ui";
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
    <div className="space-y-3">
      <div className="overflow-hidden rounded-md border border-line [&_[aria-label=Kartenausschnitt]]:h-[28rem] lg:[&_[aria-label=Kartenausschnitt]]:h-[36rem]">
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
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted">
            {picked
              ? `Vorschlag ${picked.lat.toFixed(5)}, ${picked.lon.toFixed(5)}`
              : "Klick in die Karte schlägt eine Ankerposition vor"}
          </span>
          <Button type="button" variant="primary" size="sm" onClick={submit} disabled={!picked || pending}>
            Ankerposition übernehmen
          </Button>
          {picked && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(null)}>
              Zurücksetzen
            </Button>
          )}
        </div>
      )}
      {result && (
        <p
          role={result.ok ? "status" : "alert"}
          className={cx("rounded-md border px-3 py-2 text-sm", result.ok ? "border-ok/30 bg-ok-soft" : "border-danger/30 bg-danger-soft")}
        >
          {result.ok ? result.message : result.error}
          {result.ok && result.runId && (
            <>
              {" "}
              <Link href={`/runs/${result.runId}`} className="text-accent underline-offset-2 hover:underline">
                Lauf ansehen
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}
