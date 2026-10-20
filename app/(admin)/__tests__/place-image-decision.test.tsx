import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlaceImageSubjectView } from "@/lib/domain/review-view";

vi.mock("../review/[id]/actions", () => ({ decideAction: vi.fn() }));

import { PlaceImageDecision } from "../review/[id]/place-image-decision";

const GEO = "00000000-0000-4000-8000-000000000001";

const subject = (over: Partial<PlaceImageSubjectView["context"]> = {}, slot = "title"): PlaceImageSubjectView => ({
  type: "place_image",
  geoObjectId: GEO,
  placeId: "00000000-0000-4000-8000-000000000002",
  publicId: null,
  name: "Bildbucht",
  kind: "anchorage",
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
    expect(html).toContain("Titelbild prüfen");
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

  it("disables Freigeben without a candidate and says why", () => {
    const html = render(subject({ candidateKey: null, reason: "no_valid_output", waterIoU: null }));
    expect(isDisabled(html, "Freigeben")).toBe(true);
    expect(isDisabled(html, "Neu erzeugen")).toBe(false);
    expect(isDisabled(html, "Kein Bild")).toBe(false);
    expect(html).toContain("Kein Versuch hat ein brauchbares Bild geliefert");
  });
});
