"use client";

import { useMemo, useState } from "react";
import type { GeoObjectType, PlaceKind, PoiCategory } from "@/lib/db/schema";
import type { ReviewDecision } from "@/lib/domain/review-decisions";
import { GEO_OBJECT_TYPE_LABELS, PLACE_KIND_LABELS, POI_CATEGORY_LABELS } from "../../_components/labels";
import { MiniMap } from "../../_components/mini-map";
import { DecisionForm } from "./decision-form";

const KINDS = Object.keys(PLACE_KIND_LABELS) as PlaceKind[];
const LANGUAGES: Array<[string, string]> = [
  ["de", "Deutsch"],
  ["en", "Englisch"],
  ["el", "Griechisch"],
];
const FIELD = "rounded border border-neutral-300 px-1 py-0.5";
const GREEK = /\p{Script=Greek}/u;

type Hit = { osmId: string; name: string; lon: number; lat: number; distanceM: number };

/**
 * Map of a new name (tile, Nominatim hits, nearest places) plus its "create place" decision: kind, position by a map
 * click or a hit, name and language. The geo object type follows from the name's hint (else from the kind).
 */
export function NameCandidateCreate({
  taskId,
  openedAt,
  name,
  features,
  hits,
  objectTypes,
  open,
}: {
  taskId: string;
  openedAt: string;
  name: string;
  features: GeoJSON.FeatureCollection;
  hits: Hit[];
  objectTypes: Record<PlaceKind, { type: GeoObjectType; category: PoiCategory | null }>;
  open: boolean;
}) {
  const [kind, setKind] = useState<PlaceKind>("anchorage");
  const [position, setPosition] = useState<{ lon: number; lat: number } | null>(
    hits[0] ? { lon: hits[0].lon, lat: hits[0].lat } : null,
  );
  const [placeName, setPlaceName] = useState(name);
  const [language, setLanguage] = useState(GREEK.test(name) ? "el" : "en");
  const shown = useMemo<GeoJSON.FeatureCollection>(
    () =>
      position
        ? {
            ...features,
            features: [
              ...features.features,
              { type: "Feature", geometry: { type: "Point", coordinates: [position.lon, position.lat] }, properties: { role: "picked", label: "" } },
            ],
          }
        : features,
    [features, position],
  );
  const target = objectTypes[kind];
  const trimmed = placeName.trim();
  const decision: ReviewDecision | undefined =
    position && trimmed ? { action: "create_place", kind, position, name: trimmed, language } : undefined;

  return (
    <div className="space-y-2">
      <MiniMap features={shown} onPick={open ? (lon, lat) => setPosition({ lon, lat }) : undefined} />
      {open && (
        <DecisionForm n={1} taskId={taskId} openedAt={openedAt} label="Ort anlegen" decision={decision} disabled={!decision}>
          <label className="flex items-center gap-1">
            Art
            <select value={kind} onChange={(e) => setKind(e.target.value as PlaceKind)} className={FIELD}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {PLACE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            Name
            <input value={placeName} maxLength={120} onChange={(e) => setPlaceName(e.target.value)} className={FIELD} />
          </label>
          <label className="flex items-center gap-1">
            Sprache
            <select value={language} onChange={(e) => setLanguage(e.target.value)} className={FIELD}>
              {LANGUAGES.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <span className="w-full text-neutral-600">
            Neues Objekt: {GEO_OBJECT_TYPE_LABELS[target.type]}
            {target.category ? ` (${POI_CATEGORY_LABELS[target.category]})` : ""}
            {target.type === "bay" || target.type === "harbour" ? ", mit bestätigtem Ort" : ", ohne Ort"} ·{" "}
            {position ? `Position ${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}` : "Position: Klick in die Karte oder Treffer wählen"}
          </span>
          {hits.length > 0 && (
            <span className="flex w-full flex-wrap gap-2">
              {hits.map((h) => (
                <button key={h.osmId} type="button" onClick={() => setPosition({ lon: h.lon, lat: h.lat })} className="underline">
                  {h.name} übernehmen
                </button>
              ))}
            </span>
          )}
        </DecisionForm>
      )}
    </div>
  );
}
