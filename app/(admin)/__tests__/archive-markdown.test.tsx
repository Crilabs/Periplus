import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArchiveMarkdown } from "../_components/archive-markdown";

describe("ArchiveMarkdown", () => {
  it("archive markdown renders neither raw html nor javascript links", () => {
    // The plan's sample had a 1-column delimiter row under a 2-column header, which GFM does not read as a table.
    const html = renderToStaticMarkup(
      <ArchiveMarkdown markdown={"<script>x()</script>\n\n[a](javascript:alert(1)) | t |\n|---|---|\n| 1 | 2 |"} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<table");
  });

  it("links open in a new tab without referrer, opener or ranking", () => {
    const html = renderToStaticMarkup(<ArchiveMarkdown markdown={"[Hafen](https://example.invalid/port) <img src=x onerror=alert(1)>"} />);
    expect(html).toContain('href="https://example.invalid/port"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).not.toContain("onerror");
  });

  it("images load lazily and send no referrer to their host", () => {
    const html = renderToStaticMarkup(<ArchiveMarkdown markdown={"![Bucht](https://example.invalid/bay.jpg)"} />);
    expect(html).toMatch(/<img [^>]*src="https:\/\/example.invalid\/bay.jpg"/);
    expect(html).toMatch(/<img [^>]*referrerPolicy="no-referrer"/i);
    expect(html).toMatch(/<img [^>]*loading="lazy"/);
    expect(html).toMatch(/<img [^>]*alt="Bucht"/);
  });
});
