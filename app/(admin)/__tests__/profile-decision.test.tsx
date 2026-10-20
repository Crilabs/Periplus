import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProfileAttributeSubject } from "@/lib/domain/review-view";

vi.mock("../review/[id]/actions", () => ({ decideAction: vi.fn() }));

import { ProfileDecision } from "../review/[id]/profile-decision";

const subject = (proposed: ProfileAttributeSubject["proposed"]): ProfileAttributeSubject => ({
  type: "profile_attribute",
  geoObjectId: "00000000-0000-4000-8000-000000000001",
  name: "Testbucht",
  attribute: "services.water",
  label: "Wasser",
  key: "k1",
  current: { value: true, display: "ja", provenance: null },
  proposed,
  resolution: null,
});

/** Whether the button labelled `label` carries the `disabled` attribute. */
const isDisabled = (html: string, label: string) => new RegExp(`<button[^>]* disabled=""[^>]*>${label}</button>`).test(html);

describe("ProfileDecision (uncertain change)", () => {
  const render = (s: ProfileAttributeSubject) =>
    renderToStaticMarkup(<ProfileDecision kind="uncertain_change" subject={s} taskId="t1" openedAt="2026-10-19T10:00:00.000Z" open />);

  it("disables Übernehmen when the proposed value is null, enables it for a value (also false)", () => {
    expect(isDisabled(render(subject({ value: null, display: "–", facts: [], removes: [] })), "Übernehmen")).toBe(true);
    expect(isDisabled(render(subject(undefined)), "Übernehmen")).toBe(true);
    expect(isDisabled(render(subject({ value: false, display: "nein", facts: [], removes: [] })), "Übernehmen")).toBe(false);
    expect(isDisabled(render(subject({ value: null, display: "–", facts: [], removes: [] })), "Verwerfen")).toBe(false);
  });

  it("shows both weak values of a held safety value's conflict, without conflict decisions (ruling M6-FIN-R3)", () => {
    const side = (value: number, display: string) => ({ value, fingerprint: String(value), display, weight: 0.4, observedFrom: "2026-07-01", observedTo: "2026-07-01", facts: [] });
    const html = render({ ...subject({ value: 4, display: "4 m", facts: [], removes: [] }), a: side(4, "4 m"), b: side(2, "2 m"), others: [] });
    expect(html).toContain("Wert A");
    expect(html).toContain("Wert B");
    expect(html).toContain("2 m");
    expect(html).not.toContain("Beide (saisonal)");
    expect(render(subject({ value: 4, display: "4 m", facts: [], removes: [] }))).not.toContain("Wert B");
  });

  it("names the entries „Übernehmen“ removes from a safety list (wave-1 review M-3)", () => {
    const ban = { ...subject({ value: [], display: "keine", facts: [], removes: ["Ankern verboten"] }), attribute: "prohibitions", label: "Verbote" };
    const html = render(ban);
    expect(html).toContain("„Übernehmen“ entfernt aus dem Profil: Ankern verboten.");
    expect(html).toContain("erst nach dem Reprozessieren entscheiden");
    expect(render(subject({ value: false, display: "nein", facts: [], removes: [] }))).toContain("„Übernehmen“ geht als Prüfung in das Profil ein");
  });
});
