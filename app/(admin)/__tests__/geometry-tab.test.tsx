import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlaceGeometryView } from "@/lib/domain/geometry-view";

vi.mock("../places/[id]/actions", () => ({ setPlacePositionAction: vi.fn() }));
vi.mock("../places/[id]/anchor-map", () => ({ AnchorMap: () => null }));

import { GeometryTab } from "../places/[id]/geometry-tab";

const view: PlaceGeometryView = {
  computedAt: null,
  rulesVersion: null,
  origin: null,
  originSource: null,
  sectors: null,
  swell: null,
  opening: null,
  rays: [],
  depth: { approach: null, min: null, max: null, anchoringMin: null, anchoringMax: null, confidence: null },
  depthSamples: [],
  seabed: null,
  water: null,
  anchorArea: null,
  anchorPosition: null,
  restriction: [],
  gaps: [],
  computations: [],
};
const position = { lon: 23.41234, lat: 37.71234 };

describe("GeometryTab „Position korrigieren“ (ruling M6-H-R1)", () => {
  it("offers the form with the current point on an active place only", () => {
    const html = renderToStaticMarkup(<GeometryTab placeId="p1" position={position} view={view} editable />);
    expect(html).toContain("Position korrigieren …");
    expect(html).toContain('name="placeId" value="p1"');
    expect(html).toMatch(/name="lat"[^>]*value="37.71234"/);
    expect(html).toMatch(/name="lon"[^>]*value="23.41234"/);
    expect(renderToStaticMarkup(<GeometryTab placeId="p1" position={position} view={view} editable={false} />)).not.toContain("Position korrigieren");
  });

  it("shows the result with the run", () => {
    const html = renderToStaticMarkup(<GeometryTab placeId="p1" position={position} view={view} editable positionNotice={{ status: "moved", runId: "r1" }} />);
    expect(html).toContain("Position korrigiert.");
    expect(html).toContain('href="/runs/r1"');
    expect(renderToStaticMarkup(<GeometryTab placeId="p1" position={position} view={view} editable positionNotice={{ status: "too_far" }} />)).toContain(
      "zu weit vom bisherigen Ort",
    );
  });
});
