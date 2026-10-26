/** A Markdown heading of level 1 to 3 at a line start. */
const HEADING = /^#{1,3}[ \t]+\S/gm;

const wordCount = (s: string) => s.match(/\S+/g)?.length ?? 0;

/** `text` cut hard into pieces of at most `maxWords` words, at word boundaries. */
function cutByWords(text: string, maxWords: number): string[] {
  const starts = [...text.matchAll(/\S+/g)].map((m) => m.index);
  const pieces: string[] = [];
  for (let i = 0; i < starts.length; i += maxWords) {
    const end = i + maxWords < starts.length ? starts[i + maxWords]! : text.length;
    pieces.push(text.slice(starts[i]!, end).trim());
  }
  return pieces;
}

/**
 * The sections a report goes to the route extraction in: the whole text up to `maxWords` words; above that, cut at
 * the headings of level 1 to 3 into blocks, consecutive blocks joined while they stay within `maxWords`; a block longer
 * than that (no heading to cut at) is cut hard by words. No section is empty or longer than `maxWords` words.
 */
export function routeSections(md: string, maxWords: number): string[] {
  if (wordCount(md) <= maxWords) return [md];
  const cuts = [0, ...[...md.matchAll(HEADING)].map((m) => m.index).filter((i) => i > 0), md.length];
  const blocks = cuts
    .slice(0, -1)
    .map((start, i) => md.slice(start, cuts[i + 1]).trim())
    .filter((b) => b.length > 0);
  const sections: string[] = [];
  let current: string[] = [];
  let currentWords = 0;
  const flush = () => {
    if (current.length > 0) sections.push(current.join("\n\n"));
    current = [];
    currentWords = 0;
  };
  for (const block of blocks) {
    const n = wordCount(block);
    if (n > maxWords) {
      flush();
      sections.push(...cutByWords(block, maxWords));
      continue;
    }
    if (currentWords + n > maxWords) flush();
    current.push(block);
    currentWords += n;
  }
  flush();
  return sections;
}
