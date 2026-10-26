import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlaceImageSubjectView } from "@/lib/domain/review-view";

vi.mock("../review/[id]/actions", () => ({ decideAction: vi.fn() }));

import { PlaceImageDecision } from "../review/[id]/place-image-decision";

const GEO = "00000000-0000-4000-8000-000000000001";

const PLACE: PlaceImageSubjectView["place"] = {
  geoObjectId: GEO,
  placeId: "00000000-0000-4000-8000-000000000002",
  publicId: "sp_bildbucht",
  name: "Bildbucht",
  kind: "anchorage",
  subdivision: { key: "GR-ATT", name: "Attika" },
  centre: { lon: 19.37, lat: 36.61, anchor: true },
  cove: { lon: 19.3754, lat: 36.6102 },
  town: null,
};

const subject = (over: Partial<PlaceImageSubjectView["context"]> = {}, slot = "title", place: PlaceImageSubjectView["place"] = PLACE): PlaceImageSubjectView => ({
  type: "place_image",
  place,
  slot,
  key: "k1",
  context: {
    key: "k1",
    slot,
    azimuthOverride: null,
    camera: { position: [19.37, 36.6], heightM: 260, viewBearingDeg: 0, tiltDeg: 30, fovDeg: 50 },
    renderId: "00000000-0000-4000-8000-000000000003",
    candidateKey: `imagery/candidates/${GEO}/r-1.jpg`,
    light: "midday",
    zoom: "z2",
    model: "gpt-image-test",
    promptVersion: 1,
    waterIoU: 0.72,
    passed: false,
    attempts: 2,
    watermarkVisible: false,
    alt: "KI-Illustration: Bucht",
    allowedZooms: ["z1", "z2"],
    ...over,
  },
  candidateKey: over.candidateKey === undefined ? `imagery/candidates/${GEO}/r-1.jpg` : over.candidateKey,
  photoKey: `imagery/renders/${GEO}/r/photo.png`,
  maskKey: `imagery/renders/${GEO}/r/mask.png`,
  sources: ["ktimatologio", "sentinel2", "copernicus_dem"],
  threshold: 0.8,
});

const render = (s: PlaceImageSubjectView) =>
  renderToStaticMarkup(<PlaceImageDecision subject={s} taskId="t1" openedAt="2026-10-21T10:00:00.000Z" open />);
const isDisabled = (html: string, label: string) => new RegExp(`<button[^>]* disabled=""[^>]*>${label}</button>`).test(html);

describe("PlaceImageDecision", () => {
  it("shows render and illustration, the camera line, the slot and the checks; every form posts the key", () => {
    const html = render(subject());
    // the image type as the title, the slot as its secondary line
    expect(html).toContain("Bild prüfen: Ankerplatz");
    expect(html).toContain("Titelbild");
    expect(html).not.toContain("Titelbild prüfen");
    expect(html).toContain(`src="/images/file?key=${encodeURIComponent(`imagery/renders/${GEO}/r/photo.png`)}"`);
    expect(html).toContain(`src="/images/file?key=${encodeURIComponent(`imagery/candidates/${GEO}/r-1.jpg`)}"`);
    expect(html).toContain("Maske");
    expect(html).toContain("Aufnahme von S, Blick nach N (0°), 260 m Höhe, Neigung 30°");
    expect(html).toContain("0,72 (Schwelle 0,80) ✗");
    expect(html).toContain("Mittag");
    expect(html).toContain("kein Wasserzeichen ✓");
    expect(html.match(/name="taskKey" value="k1"/g)).toHaveLength(3);
    expect(isDisabled(html, "Freigeben")).toBe(false);
    // the zoom choice: the allowed levels, the task's preselected
    expect(html).toContain("z1 (weit)");
    expect(html).not.toContain("z3 (nah)");
    expect(html).toMatch(/<option[^>]*selected=""[^>]*>z2 \(mittel\)<\/option>/);
  });

  it("names a further view by its number", () => {
    expect(render(subject({}, "view-2"))).toContain("Weitere Ansicht 2");
  });

  it("says which place it is: name linked, public id, Landesteil, anchor point and cove point", () => {
    const html = render(subject());
    expect(html).toContain('href="/places/00000000-0000-4000-8000-000000000002"');
    expect(html).toContain("Bildbucht");
    expect(html).toContain("sp_bildbucht");
    expect(html).toContain("Attika");
    expect(html).toContain("36.61000, 19.37000");
    expect(html).toContain("36.61020, 19.37540");
    // without a cove apart from the anchor point and without a name
    const plain = render(subject({}, "title", { ...PLACE, name: null, cove: null, centre: { lon: 19.37, lat: 36.61, anchor: false } }));
    expect(plain).toContain("ohne Namen");
    expect(plain).not.toContain("36.61020, 19.37540");
  });

  it("near a town: the type stays the kind, the place block names the town and its distance", () => {
    const near = render(subject({ light: "evening" }, "title", { ...PLACE, town: { geoObjectId: "00000000-0000-4000-8000-000000000009", name: "Poros", distanceM: 960.4 } }));
    expect(near).toContain("Bild prüfen: Ankerplatz");
    expect(near).not.toContain("bei einem Ort");
    expect(near).toContain("Poros (960 m)");
    expect(render(subject({}, "title", { ...PLACE, kind: "mooring_field" }))).toContain("Bild prüfen: Bojenfeld");
  });

  it("disables Freigeben without a candidate and says why", () => {
    const html = render(subject({ candidateKey: null, reason: "no_valid_output", waterIoU: null }));
    expect(isDisabled(html, "Freigeben")).toBe(true);
    expect(isDisabled(html, "Neu erzeugen")).toBe(false);
    expect(isDisabled(html, "Kein Bild")).toBe(false);
    expect(html).toContain("Kein Versuch hat ein brauchbares Bild geliefert");
  });
});
