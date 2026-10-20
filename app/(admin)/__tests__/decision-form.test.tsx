import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../review/[id]/actions", () => ({ decideAction: vi.fn() }));

import { Dialog } from "../_components/dialog";
import { DecisionForm } from "../review/[id]/decision-form";

const props = { taskId: "t1", openedAt: "2026-10-20T10:00:00.000Z" };

describe("DecisionForm", () => {
  it("a decision with `confirm` carries its question inside the form, so button and key both ask first (UI-2)", () => {
    const html = renderToStaticMarkup(
      <DecisionForm
        {...props}
        n={2}
        label="Ablehnen"
        decision={{ action: "reject" }}
        variant="danger"
        confirm={{ title: "Quelle ablehnen", description: "a.example wird dauerhaft ignoriert.", confirmLabel: "Endgültig ablehnen" }}
      />,
    );
    const form = html.match(/<form[^>]*data-decision-key="2"[^>]*>([\s\S]*)<\/form>/);
    expect(form).not.toBeNull();
    expect(form![1]).toMatch(/<dialog[^>]*aria-labelledby="([^"]+)"[\s\S]*<h2 id="\1"[^>]*>Quelle ablehnen<\/h2>/);
    expect(form![1]).toContain("a.example wird dauerhaft ignoriert.");
    expect(form![1]).toMatch(/<button type="button"[^>]*>Endgültig ablehnen<\/button>/);
    // the decision's own button stays the form's only submit button
    expect(form![1].match(/type="submit"/g)).toHaveLength(1);
  });

  it("a decision without `confirm` submits directly", () => {
    const html = renderToStaticMarkup(<DecisionForm {...props} n={1} label="Freigeben" decision={{ action: "reject" }} />);
    expect(html).not.toContain("<dialog");
  });
});

describe("Dialog", () => {
  it("names the modal by its title and describes it by its description (UI-15)", () => {
    const html = renderToStaticMarkup(
      <Dialog trigger="Öffnen" title="Alle Fundstellen" description="Drei Stellen.">
        x
      </Dialog>,
    );
    const labelled = html.match(/<dialog[^>]*aria-labelledby="([^"]+)"[^>]*aria-describedby="([^"]+)"/);
    expect(labelled).not.toBeNull();
    expect(html).toContain(`<h2 id="${labelled![1]}" class="text-base font-semibold">Alle Fundstellen</h2>`);
    expect(html).toContain(`id="${labelled![2]}"`);
  });
});
