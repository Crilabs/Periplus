import { cameraLine, imageTypeLabel, slotLabel } from "@/lib/domain/images/camera-label";
import { imageFileHref } from "@/lib/domain/images/files";
import type { CurrentImage, PlaceImageView } from "@/lib/domain/images/view";
import { Disclosure } from "../../review/[id]/parts";
import { Dialog } from "../../_components/dialog";
import { imagePlaceItems } from "../../_components/image-place";
import { Badge, Button, DescriptionList, EmptyState, Field, fmt, inputClass, Notice, Panel, TextLink } from "../../_components/ui";
import { addPlaceViewAction, removePlaceImageAction } from "./actions";

const LIGHT_LABELS = { midday: "Mittag", evening: "Abend" } as const;
const KIND_LABELS = { ai_illustration: "KI-Illustration", photo: "Foto" } as const;

const NOTICES = {
  removed: { tone: "ok", text: "Das Bild ist entfernt. Das nächste Paket liefert es nicht mehr." },
  changed: { tone: "warn", text: "Nichts entfernt: Das Bild war schon entfernt oder die Seite veraltet. Die Ansicht ist jetzt aktuell." },
} as const;

/** A picture served from the archive through the admin file route. */
function Picture({ fileKey, alt }: { fileKey: string; alt: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- archive files come through the authenticated admin route
  return <img src={imageFileHref(fileKey)} alt={alt} className="w-full rounded-md border border-line bg-sunken" />;
}

function ImagePanel({ placeId, image, editable, type }: { placeId: string; image: CurrentImage; editable: boolean; type: string | null }) {
  return (
    <Panel
      title={type ?? slotLabel(image.slot)}
      description={type ? slotLabel(image.slot) : undefined}
      actions={
        editable && (
          <Dialog
            trigger="Bild entfernen …"
            triggerVariant="danger"
            triggerSize="sm"
            title="Bild entfernen"
            description="Das Bild wird beendet und nicht mehr geliefert. Es bleibt als Verlauf erhalten; ein neues lässt sich über „Weitere Ansicht erzeugen“ oder einen Lauf anlegen."
          >
            <form action={removePlaceImageAction} className="flex justify-end">
              <input type="hidden" name="placeId" value={placeId} />
              <input type="hidden" name="imageId" value={image.id} />
              <Button variant="danger">Entfernen</Button>
            </form>
          </Dialog>
        )
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          <Picture fileKey={image.fileKey} alt={image.alt} />
          {image.render && (
            <Disclosure summary="Rendering und Maske">
              <div className="grid gap-3 sm:grid-cols-2">
                <figure className="space-y-1">
                  <Picture fileKey={image.render.photoKey} alt="Rendering aus Luftbild und Gelände" />
                  <figcaption className="text-xs text-muted">Rendering</figcaption>
                </figure>
                <figure className="space-y-1">
                  <Picture fileKey={image.render.maskKey} alt="Maske: Wasser, Land und Himmel" />
                  <figcaption className="text-xs text-muted">Maske</figcaption>
                </figure>
              </div>
            </Disclosure>
          )}
        </div>
        <DescriptionList
          columns={1}
          items={[
            { label: "Art", value: KIND_LABELS[image.kind] },
            { label: "Licht", value: image.light ? LIGHT_LABELS[image.light] : "–" },
            { label: "Quellen", value: image.attribution ?? "–" },
            { label: "Aufnahmedatum", value: image.observedAt ? fmt.date(new Date(image.observedAt)) : "–", hint: "Wann das Luftbild aufgenommen wurde" },
            { label: "Kamera", value: image.camera ? cameraLine(image.camera) : "–" },
            { label: "Wasser-IoU", value: image.waterIoU === null ? "–" : image.waterIoU.toLocaleString("de-DE", { maximumFractionDigits: 2 }), hint: "Übereinstimmung des Wassers mit der Maske" },
            { label: "Freigegeben", value: fmt.date(new Date(image.approvedAt)) },
            { label: "Lieferung", value: image.blockedBy.length === 0 ? <Badge tone="ok">lieferbar</Badge> : <Badge tone="warn">nicht geliefert</Badge> },
          ]}
        />
      </div>
    </Panel>
  );
}

/**
 * Tab „Bilder“ of the place page (spec 13): which place the images show and their type (`imageTypeLabel`, with the
 * name, ids, Landesteil, anchor and cove point and the town nearby), every current image of the place (title image
 * and further views, the type as title and the slot as its secondary line) with its kind, light, sources, imagery
 * date and camera, the render and mask behind it, the draft waiting for approval, and the form for a further view.
 */
export function ImageTab({
  placeId,
  view,
  editable,
  notice,
  zoomRefused,
}: {
  placeId: string;
  view: PlaceImageView;
  editable: boolean;
  notice?: keyof typeof NOTICES;
  zoomRefused?: boolean;
}) {
  const { images, candidates, place } = view;
  const type = place ? imageTypeLabel(place, place.town?.name ?? null) : null;
  const note = notice ? NOTICES[notice] : null;
  return (
    <div className="space-y-6">
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {place && (
        <Panel title={type!} description="Bildtyp dieses Orts: so legt das System Kamera, Licht und Szene der Bilder an">
          <DescriptionList columns={2} items={imagePlaceItems(place)} />
        </Panel>
      )}
      {zoomRefused && (
        <Notice tone="danger" title="Nicht gestartet">
          Diese Zoomstufe trägt das Luftbild des Orts nicht.
        </Notice>
      )}
      {view.blockedBy.length > 0 && (
        <Notice tone="warn" title="Nicht geliefert">
          {view.blockedBy.map((source) => `Freigabe Luftbildquelle ${source} fehlt`).join(". ")}
        </Notice>
      )}

      {candidates.map((c) => (
        <Panel
          key={c.taskId}
          title={`${type ?? slotLabel(c.slot)}: Entwurf, wartet auf Freigabe`}
          description={`${type ? `${slotLabel(c.slot)}, ` : ""}${c.passed ? "Prüfungen bestanden" : "Prüfungen nicht bestanden"}${c.light ? `, Licht: ${LIGHT_LABELS[c.light]}` : ""}${c.waterIoU === null ? "" : `, Wasser-IoU ${c.waterIoU.toLocaleString("de-DE", { maximumFractionDigits: 2 })}`}`}
          actions={<TextLink href={`/review/${c.taskId}`}>Zur Prüfung</TextLink>}
        >
          <div className="max-w-2xl">
            <Picture fileKey={c.candidateKey} alt={`Entwurf ${slotLabel(c.slot)}`} />
          </div>
        </Panel>
      ))}

      {images.length === 0 && candidates.length === 0 && (
        <Panel>
          <EmptyState title="Noch keine Bilder">
            Das Titelbild entsteht mit dem Lauf „Titelbilder erzeugen“ des Landesteils oder über „Weitere Ansicht erzeugen“.
          </EmptyState>
        </Panel>
      )}

      {images.map((image) => (
        <ImagePanel key={image.id} placeId={placeId} image={image} editable={editable} type={type} />
      ))}

      {editable && (
        <div className="flex">
          <Dialog
            trigger="Weitere Ansicht erzeugen"
            triggerVariant="primary"
            title="Weitere Ansicht erzeugen"
            description="Erzeugt ein weiteres Bild des Orts aus einer anderen Zoomstufe oder Blickrichtung. Es kostet einen Bildaufruf und kommt zur Freigabe in die Prüfung."
          >
            <form action={addPlaceViewAction} className="space-y-4">
              <input type="hidden" name="placeId" value={placeId} />
              <Field label="Zoomstufe" hint="Nur Stufen, die das Luftbild des Orts scharf genug trägt.">
                <select name="zoom" defaultValue={view.zooms[0]} className={inputClass}>
                  {view.zooms.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Blickrichtung (optional)" hint="Grad im Uhrzeigersinn ab Nord, 0 bis 359. Leer: die Richtung wählt das System.">
                <input name="azimuthDeg" type="number" min={0} max={359} step={1} className={inputClass} />
              </Field>
              <div className="flex justify-end">
                <Button variant="primary">Erzeugen</Button>
              </div>
            </form>
          </Dialog>
        </div>
      )}
    </div>
  );
}
