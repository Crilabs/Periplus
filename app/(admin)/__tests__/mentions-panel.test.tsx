import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MentionsPanel } from "../_components/mentions-panel";

/* The documents mentioning an object: geo page and the place page's „Quellen“ tab (spec 09, UI-13). */
describe("MentionsPanel", () => {
  it("links each mention's document and highlights the quote; pages through the rest", () => {
    const row = {
      id: "m1",
      documentId: "d1",
      url: "https://guide.test.invalid/hydra",
      domain: "guide.test.invalid",
      observedAt: "2026-06-01",
      matchKind: "deterministic" as const,
      confidence: 1,
      snippet: { before: "Anchor in ", quote: "Mandraki", after: " bay." },
    };
    const html = renderToStaticMarkup(
      <MentionsPanel mentions={{ rows: [row], total: 60 }} page={1} pageHref={(p) => `/places/x?tab=sources&mp=${p}`} />,
    );
    expect(html).toContain("Erwähnungen (60)");
    expect(html).toContain('href="/documents/d1"');
    expect(html).toContain("Mandraki");
    expect(html).toContain("/places/x?tab=sources&amp;mp=2");
  });
});
