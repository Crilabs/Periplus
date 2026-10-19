/** Lines with at least this many column gaps are table-like. */
const MIN_GAPS = 2;
/** Consecutive table-like lines that make a table block. */
const MIN_TABLE_LINES = 3;
/** Longest line taken as a heading when it stands alone in upper case. */
const MAX_HEADING_CHARS = 60;
/** Share of non-whitespace characters outside letters, digits and punctuation above which a page is garbage. */
const MAX_GARBAGE_SHARE = 0.2;

export type PdfPage = { page: number; chars: number; unreadable: boolean; markdown: string };

/** Gaps of two or more spaces between the words of a line (indentation does not count). */
function gapCount(line: string): number {
  return line.trim().match(/ {2,}/g)?.length ?? 0;
}

function isHeading(line: string): boolean {
  return line.length <= MAX_HEADING_CHARS && /\p{Lu}/u.test(line) && !/\p{Ll}/u.test(line);
}

/**
 * A paragraph's lines joined with spaces. A word broken with `-` at the line end is joined: without the hyphen
 * before a lower-case letter (hyphenation), with it before an upper-case one (a compound like `Moni-Insel`).
 */
function joinLines(lines: string[]): string {
  let text = "";
  for (const line of lines) {
    const broken = /\p{L}-$/u.test(text);
    if (broken && /^\p{Ll}/u.test(line)) text = text.slice(0, -1) + line;
    else if (broken && /^\p{Lu}/u.test(line)) text += line;
    else text = text ? `${text} ${line}` : line;
  }
  return text;
}

/** Markdown blocks of one page of `pdftotext -layout` text. */
function pageBlocks(text: string): string[] {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push(paragraph.length === 1 && isHeading(paragraph[0]!) ? `## ${paragraph[0]}` : joinLines(paragraph));
    paragraph = [];
  };
  for (let i = 0; i < lines.length; ) {
    let end = i;
    while (end < lines.length && gapCount(lines[end]!) >= MIN_GAPS) end++;
    if (end - i >= MIN_TABLE_LINES) {
      flush();
      blocks.push(["```text", ...lines.slice(i, end), "```"].join("\n"));
      i = end;
      continue;
    }
    const line = lines[i]!.trim();
    if (line) paragraph.push(line.replace(/\s+/g, " "));
    else flush();
    i++;
  }
  flush();
  return blocks;
}

/**
 * Whether a page's extracted text is unusable: fewer than `minChars` letters, or more than 20 % of its
 * non-whitespace characters outside letters, digits and punctuation (replacement or private-use characters of a
 * broken font encoding).
 */
export function isUnreadable(pageText: string, minChars: number): boolean {
  const letters = pageText.match(/\p{L}/gu)?.length ?? 0;
  if (letters < minChars) return true;
  const visible = pageText.replace(/\s/g, "");
  const garbage = visible.match(/[^\p{L}\p{N}\p{P}]/gu)?.length ?? 0;
  return garbage > visible.length * MAX_GARBAGE_SHARE;
}

/**
 * Markdown from `pdftotext -layout` text. Pages split at form feeds (the one after the last page ends the text);
 * each starts with `<!-- page N -->`. At least 3 consecutive lines with 2 or more gaps of 2+ spaces (columns of
 * depth and berth tables) stay unchanged in a fenced `text` block; other lines form paragraphs (lines joined with
 * spaces, a hyphen at a line end before a lower-case letter joined away); an upper-case line of at most 60
 * characters standing alone becomes a `##` heading.
 *
 * `pages[].chars` counts non-whitespace characters, `unreadable` is `isUnreadable(page, minChars)` and
 * `markdown` is the page's own section (marker included), for replacing single pages.
 */
export function layoutToMarkdown(text: string, minChars: number): { markdown: string; pages: PdfPage[] } {
  const raw = text.split("\f");
  if (raw.length > 1 && raw.at(-1)!.trim() === "") raw.pop();
  const pages = raw.map((pageText, i): PdfPage => {
    const marker = `<!-- page ${i + 1} -->`;
    const blocks = pageBlocks(pageText);
    return {
      page: i + 1,
      chars: pageText.replace(/\s/g, "").length,
      unreadable: isUnreadable(pageText, minChars),
      markdown: [marker, ...blocks].join("\n\n"),
    };
  });
  return { markdown: pages.map((p) => p.markdown).join("\n\n"), pages };
}
