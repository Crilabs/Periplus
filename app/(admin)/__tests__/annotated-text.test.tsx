import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnnotatedText } from "../_components/annotated-text";

describe("AnnotatedText", () => {
  it("annotated text escapes html in the source text", () => {
    const html = renderToStaticMarkup(
      <AnnotatedText text={"<img src=x onerror=a()> Kolona"} spans={[{ start: 24, end: 30, kind: "mention", ref: "m" }]} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=a()&gt; ");
    expect(html).toContain('<mark data-kind="mention">Kolona</mark>');
  });

  it("marks overlapping spans with all their kinds", () => {
    const html = renderToStaticMarkup(
      <AnnotatedText
        text="Ormos Vathy bietet guten Schutz"
        spans={[
          { start: 6, end: 11, kind: "mention", ref: "m" },
          { start: 6, end: 30, kind: "quote", ref: "f" },
        ]}
      />,
    );
    expect(html).toContain('Ormos <mark data-kind="mention quote">Vathy</mark><mark data-kind="quote"> bietet guten Schut</mark>z');
  });
});
