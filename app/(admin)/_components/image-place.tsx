import { pointLabel } from "@/lib/domain/images/camera-label";
import type { ImagePlaceInfo } from "@/lib/domain/images/place-info";
import { PLACE_KIND_LABELS } from "./labels";
import { Mono, TextLink } from "./ui";

/**
 * Which place an image shows, for a `DescriptionList` of the review panel „Bild prüfen“ and the place's image tab:
 * the name linked to the place, its kind, public id and Landesteil, the anchor point (or the position without one),
 * the cove point when it lies apart, and the nearest town (town or city) with its distance.
 */
export function imagePlaceItems(place: ImagePlaceInfo) {
  return [
    { label: "Ort", value: <TextLink href={`/places/${place.placeId}`}>{place.name ?? "ohne Namen"}</TextLink> },
    { label: "Art", value: PLACE_KIND_LABELS[place.kind] },
    { label: "Öffentliche ID", value: place.publicId ? <Mono>{place.publicId}</Mono> : "–" },
    { label: "Landesteil", value: place.subdivision ? (place.subdivision.name ?? place.subdivision.key) : "–" },
    {
      label: place.centre.anchor ? "Ankerpunkt" : "Position",
      value: <Mono>{pointLabel(place.centre)}</Mono>,
      hint: place.centre.anchor ? "Berechneter Ankerpunkt; hier beginnt die Kamerawahl" : "Position des Orts; ein Ankerpunkt ist nicht berechnet",
    },
    !!place.cove && { label: "Buchtpunkt", value: <Mono>{pointLabel(place.cove)}</Mono>, hint: "Der benannte Punkt der Bucht (OSM); die Kamera blickt vom Ankerpunkt auf ihn" },
    !!place.town && {
      label: "Stadt in der Nähe",
      value: `${place.town.name ?? "ohne Namen"} (${Math.round(place.town.distanceM).toLocaleString("de-DE")} m)`,
      hint: "Nächste Stadt im Umkreis; liegt sie im Bild, wird das Bild eines Ankerplatzes am Abend erzeugt",
    },
  ];
}
