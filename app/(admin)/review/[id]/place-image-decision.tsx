import type { ZoomLevel } from "@/lib/config";
import type { ImagerySource } from "@/lib/db/schema";
import { cameraLine, slotLabel } from "@/lib/domain/images/camera-label";
import { imageFileHref } from "@/lib/domain/images/files";
import type { PlaceImageSubjectView } from "@/lib/domain/review-view";
import { PLACE_KIND_LABELS } from "../../_components/labels";
import { cx, DescriptionList, inputClass, Mono, Notice, Panel, TextLink } from "../../_components/ui";
import { DecisionForm } from "./decision-form";
import { DecisionPanel, Disclosure } from "./parts";

const LIGHT_LABELS = { midday: "Mittag", evening: "Abend" } as const;
const ZOOM_LABELS: Record<ZoomLevel, string> = { z1: "z1 (weit)", z2: "z2 (mittel)", z3: "z3 (nah)" };
const SOURCE_LABELS: Partial<Record<ImagerySource, string>> = {
  ktimatologio: "Luftbild Hellenic Cadastre",
  sentinel2: "Sentinel-2",
  copernicus_dem: "Copernicus DEM",
};
const REASON_TEXT = {
  no_water_view: "Aus keiner Richtung liegt die Kamera über Wasser, deshalb gibt es kein Rendering und keine Illustration. Mit einer anderen Zoomstufe neu erzeugen oder „Kein Bild“ wählen.",
  no_valid_output: "Kein Versuch hat ein brauchbares Bild geliefert. Neu erzeugen oder „Kein Bild“ wählen.",
} as const;

const share = (n: number) => n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SELECT = cx(inputClass, "h-8 min-w-0 max-w-full");

/** One archived image with its caption; a placeholder when there is none. */
function Figure({ label, fileKey, alt }: { label: string; fileKey: string | null; alt: string }) {
  return (
    <figure className="space-y-1.5">
      <figcaption className="text-xs font-medium text-muted">{label}</figcaption>
      {fileKey ? (
        // eslint-disable-next-line @next/next/no-img-element -- archive bytes behind the admin session, no optimisation
        <img src={imageFileHref(fileKey)} alt={alt} className="aspect-[3/2] w-full rounded-md border border-line bg-sunken object-cover" />
      ) : (
        <div className="flex aspect-[3/2] w-full items-center justify-center rounded-md border border-dashed border-line bg-sunken text-xs text-muted">
          Kein Bild
        </div>
      )}
    </figure>
  );
}

/**
 * A `place_image` task, „Titelbild prüfen“: the render and the AI illustration side by side (the mask folds away), the
 * slot and the camera, the checks (water IoU against its threshold, light, zoom, attempts, watermark check) and the
 * decisions „Freigeben“, „Neu erzeugen“ (zoom from `allowedZooms`, default the task's) and „Kein Bild“. Every decision
 * posts the context key as shown (`taskKey`). Without a candidate (`reason`), „Freigeben“ is disabled here and refused
 * by the server.
 */
export function PlaceImageDecision({
  subject,
  taskId,
  openedAt,
  open,
}: {
  subject: PlaceImageSubjectView;
  taskId: string;
  openedAt: string;
  open: boolean;
}) {
  const c = subject.context;
  const props = { taskId, openedAt, taskKey: subject.key };
  const approvable = !c.reason && subject.candidateKey !== null && c.camera !== null;
  const zooms = c.allowedZooms.length > 0 ? c.allowedZooms : (Object.keys(ZOOM_LABELS) as ZoomLevel[]);
  const iouPassed = c.waterIoU !== null && c.waterIoU >= subject.threshold;
  const slot = slotLabel(subject.slot);

  return (
    <>
      {c.reason && <Notice tone="warn">{REASON_TEXT[c.reason]}</Notice>}
      <div className="grid gap-6 lg:grid-cols-5">
        {open && (
          <DecisionPanel question={`${slot} freigeben, neu erzeugen oder ohne Bild lassen?`} className="lg:col-span-2">
            <DecisionForm
              {...props}
              n={1}
              label="Freigeben"
              decision={{ action: "approve_image" }}
              variant="primary"
              disabled={!approvable}
              hint={approvable ? `Die Illustration wird das aktuelle ${slot}; ein bisheriges Bild dieses Platzes endet.` : "Nicht möglich: es gibt keine Illustration."}
            />
            <DecisionForm
              {...props}
              n={2}
              label="Neu erzeugen"
              hint="Erzeugt das Bild erneut, auf Wunsch mit einer anderen Zoomstufe. Kostet einen neuen Bildaufruf."
            >
              <select name="decision" aria-label="Zoomstufe" defaultValue={JSON.stringify({ action: "regenerate_image", zoom: c.zoom })} className={cx(SELECT, "flex-1")}>
                {zooms.map((z) => (
                  <option key={z} value={JSON.stringify({ action: "regenerate_image", zoom: z })}>
                    {ZOOM_LABELS[z]}
                  </option>
                ))}
              </select>
            </DecisionForm>
            <DecisionForm
              {...props}
              n={3}
              label="Kein Bild"
              decision={{ action: "no_image" }}
              variant="danger"
              hint={`Kein ${slot} für diesen Stand; ein bisheriges Bild dieses Platzes endet, andere Ansichten bleiben.`}
            />
          </DecisionPanel>
        )}
        <Panel title="Titelbild prüfen" description={slot} className={open ? "lg:col-span-3" : "lg:col-span-5"}>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Figure label="Rendering" fileKey={subject.photoKey} alt={`Rendering von ${subject.name ?? "dem Ort"}`} />
              <Figure label="KI-Illustration" fileKey={subject.candidateKey} alt={c.alt} />
            </div>
            {subject.maskKey && (
              <Disclosure summary="Maske (Wasser weiß, Land schwarz, Himmel grau)">
                <Figure label="Maske" fileKey={subject.maskKey} alt="Maske des Renderings" />
              </Disclosure>
            )}
            <p className="text-sm">{c.camera ? cameraLine(c.camera) : "Keine Kamera über Wasser"}</p>
          </div>
        </Panel>
      </div>
      <Panel title="Prüfwerte">
        <DescriptionList
          columns={2}
          items={[
            {
              label: "Ort",
              value: <TextLink href={`/places/${subject.placeId}`}>{subject.name ?? subject.placeId}</TextLink>,
            },
            { label: "Art", value: PLACE_KIND_LABELS[subject.kind] },
            { label: "Bild", value: slot },
            {
              label: "Wasser-IoU",
              hint: "Überdeckung des Wassers im Rendering und in der Illustration, 0 bis 1",
              value:
                c.waterIoU === null ? (
                  "–"
                ) : (
                  <span className={iouPassed ? "text-ok" : "text-danger"}>
                    {share(c.waterIoU)} (Schwelle {share(subject.threshold)}) {iouPassed ? "✓" : "✗"}
                  </span>
                ),
            },
            { label: "Licht", value: LIGHT_LABELS[c.light] },
            { label: "Zoom", value: ZOOM_LABELS[c.zoom] ?? c.zoom },
            { label: "Versuche", value: c.attempts },
            {
              label: "Wasserzeichen-Prüfung",
              value: c.watermarkVisible === null ? "nicht geprüft" : c.watermarkVisible ? "Wasserzeichen sichtbar ✗" : "kein Wasserzeichen ✓",
            },
            { label: "Quellen", value: subject.sources.map((s) => SOURCE_LABELS[s] ?? s).join(" · ") || "–" },
            { label: "Modell", value: `${c.model} · Prompt v${c.promptVersion}` },
            !!subject.publicId && { label: "Öffentliche ID", value: <Mono>{subject.publicId}</Mono> },
          ]}
        />
      </Panel>
    </>
  );
}
