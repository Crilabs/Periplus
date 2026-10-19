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
    expect(isDisabled(render(subject({ value: null, display: "–", facts: [] })), "Übernehmen")).toBe(true);
    expect(isDisabled(render(subject(undefined)), "Übernehmen")).toBe(true);
    expect(isDisabled(render(subject({ value: false, display: "nein", facts: [] })), "Übernehmen")).toBe(false);
    expect(isDisabled(render(subject({ value: null, display: "–", facts: [] })), "Verwerfen")).toBe(false);
  });
});
