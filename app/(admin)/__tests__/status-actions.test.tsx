import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../places/[id]/actions", () => ({ setPlaceStatusAction: vi.fn() }));

import { StatusActions } from "../places/[id]/status-actions";

const PLACE = "0199f0a0-0000-7000-8000-000000000001";

/** The forms of the rendered header actions, each with its target status, the shown status and whether a dialog wraps it. */
function forms(html: string) {
  return [...html.matchAll(/(<dialog[\s\S]*?<\/dialog>)|(<form[\s\S]*?<\/form>)/g)].map((m) => {
    const part = m[0];
    return {
      status: part.match(/name="status" value="([^"]+)"/)?.[1],
      from: part.match(/name="from" value="([^"]+)"/)?.[1],
      inDialog: part.startsWith("<dialog"),
    };
  });
}

describe("StatusActions (W4-2)", () => {
  it("on a candidate, „Bestätigen“ submits directly; „Verwerfen“ and „Kein Ankerplatz“ ask first; every form posts the shown status", () => {
    const html = renderToStaticMarkup(<>{StatusActions({ placeId: PLACE, status: "candidate" })}</>);
    expect(forms(html)).toEqual([
      { status: "confirmed", from: "candidate", inDialog: false },
      { status: "rejected", from: "candidate", inDialog: true },
      { status: "no_anchoring", from: "candidate", inDialog: true },
    ]);
    expect(html).toMatch(/<h2 id="[^"]+"[^>]*>Verwerfen<\/h2>/);
    expect(html).toMatch(/<h2 id="[^"]+"[^>]*>Kein Ankerplatz<\/h2>/);
  });

  it("on a confirmed place both withdrawals ask first and name the effect on the next package", () => {
    const html = renderToStaticMarkup(<>{StatusActions({ placeId: PLACE, status: "confirmed" })}</>);
    expect(forms(html)).toEqual([
      { status: "rejected", from: "confirmed", inDialog: true },
      { status: "no_anchoring", from: "confirmed", inDialog: true },
    ]);
    expect(html).toContain("das nächste Paket seines Reviers meldet ihn als entfernt");
  });
});
