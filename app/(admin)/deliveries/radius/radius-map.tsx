"use client";

import { useState, useTransition } from "react";
import { MiniMap } from "../../_components/mini-map";
import { Button, Notice } from "../../_components/ui";
import { downloadRadiusZip } from "./actions";

const LEGEND: Array<[string, string]> = [
  ["#60a5fa", "Umkreis"],
  ["#f87171", "Heimatmarina"],
  ["#4ade80", "Landesteil geliefert"],
  ["#facc15", "Landesteil fehlt"],
];

/** The preview map: circle, home marina and the touched subdivisions (colour per `color`), with its legend. */
export function RadiusMap({ features }: { features: GeoJSON.FeatureCollection }) {
  return (
    <div className="space-y-2">
      <MiniMap features={features} />
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legende">
        {LEGEND.map(([color, label]) => (
          <li key={label} className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-full" style={{ background: color }} aria-hidden />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** „Als ZIP laden“: calls the action and hands the bytes to the browser as a download. */
export function RadiusZipButton({ marina, days }: { marina: string; days: number }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    start(async () => {
      setError(null);
      try {
        const result = await downloadRadiusZip(marina, days);
        if (typeof result === "string") {
          setError(result === "invalid_days" ? "Tage außerhalb des erlaubten Bereichs." : "Marina nicht gefunden.");
          return;
        }
        const url = URL.createObjectURL(new Blob([new Uint8Array(result.zip)], { type: "application/zip" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = result.filename;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        setError("ZIP konnte nicht erzeugt werden.");
      }
    });
  return (
    <div className="space-y-2">
      <Button type="button" variant="primary" onClick={load} disabled={pending}>
        {pending ? "Wird gepackt …" : "Als ZIP laden"}
      </Button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
