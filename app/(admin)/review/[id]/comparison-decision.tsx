import type { ComparisonSubjectView } from "@/lib/domain/review-view";
import {
  COMPARISON_ATTRIBUTE_LABELS,
  COMPARISON_DECISION_LABELS,
  PLACE_KIND_LABELS,
  PLACE_STATUS_LABELS,
} from "../../_components/labels";
import { MiniMap } from "../../_components/mini-map";
import { DescriptionList, Mono, Notice, Panel, TextLink } from "../../_components/ui";
import { DecisionForm } from "./decision-form";
import { DecisionPanel, MapLegend } from "./parts";

const coord = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

/**
 * A `comparison_deviation` task: the place on a map, the compared attribute and the own value; the admin checks the
 * Navily value in the Navily app and decides (keys 1–3). Nothing of Navily is shown or stored here (Grundprinzip 9).
 */
export function ComparisonDecision({
  subject,
  features,
  taskId,
  openedAt,
  open,
}: {
  subject: ComparisonSubjectView;
  features: GeoJSON.FeatureCollection;
  taskId: string;
  openedAt: string;
  open: boolean;
}) {
  const props = { taskId, openedAt };
  const attribute = COMPARISON_ATTRIBUTE_LABELS[subject.attribute];
  return (
    <>
      <Notice tone="warn">In der Navily-App prüfen – Navily-Werte werden nicht gespeichert.</Notice>
      <div className="grid gap-6 lg:grid-cols-5">
        {open && (
          <DecisionPanel
            question={`Der eigene Wert für „${attribute}“ weicht vom Navily-Vergleich ab. Welcher Wert stimmt?`}
            className="lg:col-span-2"
            note="Gespeichert wird nur das Ergebnis. Es gilt, solange sich der eigene Wert nicht ändert."
          >
            <DecisionForm
              {...props}
              n={1}
              label={COMPARISON_DECISION_LABELS.own_correct}
              decision={{ action: "own_correct" }}
              variant="primary"
              hint="Zählt in der Fact-Präzision als richtig."
            />
            <DecisionForm
              {...props}
              n={2}
              label={COMPARISON_DECISION_LABELS.navily_correct}
              decision={{ action: "navily_correct" }}
              hint="Zählt in der Fact-Präzision als falsch."
            />
            <DecisionForm
              {...props}
              n={3}
              label={COMPARISON_DECISION_LABELS.unclear}
              decision={{ action: "unclear" }}
              hint="Zählt in der Fact-Präzision nicht als richtig (wie „falsch“)."
            />
          </DecisionPanel>
        )}
        <Panel title="Karte" className={open ? "lg:col-span-3" : "lg:col-span-5"}>
          <MiniMap features={features} />
          <MapLegend items={[["subject", "Ort"]]} />
        </Panel>
      </div>
      <Panel title="Vergleich">
        <DescriptionList
          columns={2}
          items={[
            {
              label: "Ort",
              value: <TextLink href={`/places/${subject.place.id}`}>{subject.place.name ?? subject.place.id}</TextLink>,
            },
            { label: "Art und Status", value: `${PLACE_KIND_LABELS[subject.place.kind]} · ${PLACE_STATUS_LABELS[subject.place.status]}` },
            { label: "Position", value: <Mono>{coord(subject.place.position.lat, subject.place.position.lon)}</Mono> },
            !!subject.place.publicId && { label: "Öffentliche ID", value: <Mono>{subject.place.publicId}</Mono> },
            { label: "Attribut", value: attribute },
            { label: "Eigener Wert", value: <span className="font-semibold">{subject.ownDisplay ?? "–"}</span> },
          ]}
        />
      </Panel>
    </>
  );
}
