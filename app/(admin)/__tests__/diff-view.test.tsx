import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffView } from "../_components/diff-view";

describe("DiffView", () => {
  it("renders every line as phrasing content inside the pre", () => {
    const html = renderToStaticMarkup(
      <DiffView
        lines={[
          { kind: "same", text: "Bucht" },
          { kind: "removed", text: "alt" },
          { kind: "added", text: "neu" },
        ]}
      />,
    );
    expect(html).toMatch(/^<pre[^>]*>.*<\/pre>$/);
    expect(html).not.toContain("<div");
    expect(html.match(/<span class="block[^"]*">/g)).toHaveLength(3);
    expect(html).toContain("- alt");
    expect(html).toContain("+ neu");
  });
});
