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
const view = (over: Partial<PlaceImageView>): PlaceImageView => ({
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

  it("offers „Bild entfernen“ and „Weitere Ansicht erzeugen“ only for an editable place", () => {
    const v = view({ images: [image], current: image });
    expect(html(v, true)).toContain("Bild entfernen");
    expect(html(v, true)).toContain("Weitere Ansicht erzeugen");
    expect(html(v, false)).not.toContain("Bild entfernen");
    expect(html(v, false)).not.toContain("Weitere Ansicht erzeugen");
  });
});
