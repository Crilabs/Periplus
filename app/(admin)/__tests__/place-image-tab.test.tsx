import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CurrentImage, PlaceImageView } from "@/lib/domain/images/view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("../places/[id]/actions", () => ({
  addPlaceViewAction: vi.fn(),
  removePlaceImageAction: vi.fn(),
}));

import { ImageTab } from "../places/[id]/image-tab";

const image: CurrentImage = {
  id: "00000000-0000-4000-8000-000000000001",
  slot: "title",
  sortOrder: 0,
  kind: "ai_illustration",
  light: "midday",
  alt: "KI-Illustration: Bucht",
  attribution: null,
  observedAt: null,
  fileKey: "images/x.jpg",
  waterIoU: 0.9,
  approvedAt: "2026-10-20",
  camera: null,
  render: null,
  blockedBy: [],
};
const PLACE: NonNullable<PlaceImageView["place"]> = {
  geoObjectId: "00000000-0000-4000-8000-000000000010",
  placeId: "p",
  publicId: "sp_bildbucht",
  name: "Bildbucht",
  kind: "anchorage",
  subdivision: { key: "GR-ATT", name: "Attika" },
  centre: { lon: 19.37, lat: 36.61, anchor: true },
  cove: { lon: 19.3754, lat: 36.6102 },
  town: null,
  composition: "open_water",
};
const view = (over: Partial<PlaceImageView>): PlaceImageView => ({
  place: null,
  current: null,
  images: [],
  candidate: null,
  candidates: [],
  latestRender: null,
  deliverable: false,
  blockedBy: [],
  zooms: ["z1"],
  ...over,
});
const html = (v: PlaceImageView, editable = true) =>
  renderToStaticMarkup(<ImageTab placeId="p" view={v} editable={editable} />);

describe("ImageTab", () => {
  it("says „Noch keine Bilder“ without images", () => {
    expect(html(view({}))).toContain("Noch keine Bilder");
  });

  it("names each blocked source once, without repeating the title", () => {
    const out = html(
      view({
        images: [image],
        current: image,
        blockedBy: ["ktimatologio", "x"],
      }),
    );
    expect(out).toContain(
      "Freigabe Luftbildquelle ktimatologio fehlt. Freigabe Luftbildquelle x fehlt",
    );
    expect(out).not.toContain("Nicht geliefert: Freigabe");
  });

  it("shows the image type as the title of each image, the slot as its secondary line, and which place it is", () => {
    const out = html(view({ place: PLACE, images: [image], current: image }));
    expect(out).toContain("Ankerplatz");
    expect(out).toContain("Titelbild");
    expect(out).toContain('href="/places/p"');
    expect(out).toContain("Bildbucht");
    expect(out).toContain("sp_bildbucht");
    expect(out).toContain("Attika");
    expect(out).toContain("36.61000, 19.37000");
    expect(out).toContain("Buchtpunkt");
    expect(out).toContain("36.61020, 19.37540");
    const near = html(
      view({ place: { ...PLACE, composition: "near_town", cove: null, town: { geoObjectId: "t", name: "Poros", distanceM: 960 } }, images: [image], current: image }),
    );
    expect(near).toContain("Ankerplatz bei einem Ort – Poros");
    expect(near).toContain("Poros (960 m)");
    expect(near).not.toContain("Buchtpunkt");
  });

  it("offers „Bild entfernen“ and „Weitere Ansicht erzeugen“ only for an editable place", () => {
    const v = view({ images: [image], current: image });
    expect(html(v, true)).toContain("Bild entfernen");
    expect(html(v, true)).toContain("Weitere Ansicht erzeugen");
    expect(html(v, false)).not.toContain("Bild entfernen");
    expect(html(v, false)).not.toContain("Weitere Ansicht erzeugen");
  });
});
