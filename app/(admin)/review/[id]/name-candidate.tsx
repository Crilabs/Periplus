"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { GeoObjectType, PlaceKind, PoiCategory } from "@/lib/db/schema";
import type { ReviewDecision } from "@/lib/domain/review-decisions";
import { GEO_OBJECT_TYPE_LABELS, PLACE_KIND_LABELS, POI_CATEGORY_LABELS } from "../../_components/labels";
import { MiniMap } from "../../_components/mini-map";
import { Button, cx, inputClass, Panel } from "../../_components/ui";
import { DecisionForm } from "./decision-form";
import { DecisionPanel, MapLegend } from "./parts";

const KINDS = Object.keys(PLACE_KIND_LABELS) as PlaceKind[];
const LANGUAGES: Array<[string, string]> = [
  ["de", "Deutsch"],
  ["en", "Englisch"],
  ["el", "Griechisch"],
];
const FIELD = cx(inputClass, "h-8");
const GREEK = /\p{Script=Greek}/u;

type Hit = { osmId: string; name: string; lon: number; lat: number; distanceM: number };

/**
 * Map of a new name (tile, Nominatim hits, nearest places) plus its "create place" decision: kind, position by a map
 * click or a hit, name and language. The geo object type follows from the name's hint (else from the kind).
 * `children` are the task's further decisions, shown in the same decision block.
 */
export function NameCandidateCreate({
  taskId,
  openedAt,
  name,
  features,
  hits,
  objectTypes,
  suggestedKind,
  open,
  question,
  children,
}: {
  taskId: string;
  openedAt: string;
  name: string;
  features: GeoJSON.FeatureCollection;
  hits: Hit[];
  objectTypes: Record<PlaceKind, { type: GeoObjectType; category: PoiCategory | null }>;
  /** The kind the form starts with (from the name's hint). */
  suggestedKind: PlaceKind;
  open: boolean;
  question?: ReactNode;
  children?: ReactNode;
}) {
  const [kind, setKind] = useState<PlaceKind>(suggestedKind);
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

  const map = (
    <Panel
      title="Karte"
      description={
        open
          ? "Rot die Kachel, in der der Name vorkommt. Ein Klick in die Karte setzt die Position für „Ort anlegen“."
          : "Rot die Kachel, in der der Name vorkommt."
      }
    >
      <MiniMap features={shown} onPick={open ? (lon, lat) => setPosition({ lon, lat }) : undefined} />
      <MapLegend
        items={[
          ["subject", "Kachel"],
          ...(hits.length > 0 ? [["hit", "Nominatim-Treffer"] as ["hit", string]] : []),
          ["nearby", "Orte in der Nähe"],
          ...(position ? [["picked", "Gewählte Position"] as ["picked", string]] : []),
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
          label="Ort anlegen"
          decision={decision}
          disabled={!decision}
          variant="primary"
          hint={
            <>
              Legt ein neues Geo-Objekt an: {GEO_OBJECT_TYPE_LABELS[target.type]}
              {target.category ? ` (${POI_CATEGORY_LABELS[target.category]})` : ""}
              {target.type === "bay" || target.type === "harbour" ? ", mit bestätigtem Ort" : ", ohne Ort"}. Die Texte mit
              dem Namen werden danach neu zugeordnet.
            </>
          }
        >
          <div className="grid w-full gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-muted">
              Art
              <select value={kind} onChange={(e) => setKind(e.target.value as PlaceKind)} className={FIELD}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {PLACE_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Sprache
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className={FIELD}>
                {LANGUAGES.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted sm:col-span-2">
              Name
              <input value={placeName} maxLength={120} onChange={(e) => setPlaceName(e.target.value)} className={FIELD} />
            </label>
          </div>
          <p className={cx("w-full text-xs", position ? "text-muted" : "text-warn")}>
            {position
              ? `Position ${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}`
              : "Position fehlt: Klick in die Karte oder einen Treffer übernehmen."}
          </p>
          {hits.length > 0 && (
            <span className="flex w-full flex-wrap gap-2">
              {hits.map((h) => (
                <Button key={h.osmId} type="button" size="sm" variant="ghost" onClick={() => setPosition({ lon: h.lon, lat: h.lat })}>
                  {h.name} übernehmen
                </Button>
              ))}
            </span>
          )}
        </DecisionForm>
        {children}
      </DecisionPanel>
      <div className="lg:col-span-3">{map}</div>
    </div>
  );
}
