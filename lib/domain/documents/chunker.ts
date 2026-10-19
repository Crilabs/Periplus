import type { FetchConfig } from "@/lib/config";
import { normalizeMarkdown, normalizeText, sha256Hex } from "@/lib/domain/documents/normalize";

export type ChunkDraft = {
  ordinal: number;
  /** Slice `charStart…charEnd` of the normalized Markdown. */
  text: string;
  textNormalized: string;
  /** sha256 hex of `textNormalized`. */
  textHash: string;
  /** Text of the level 1–3 heading whose section the chunk belongs to. */
  heading: string | null;
  charStart: number;
  charEnd: number;
  /** Words split at whitespace. */
  wordCount: number;
};

type ChunkConfig = FetchConfig["chunk"];

/** A run of the Markdown chunks are built from: a block, or a sentence-bounded piece of an over-long block. */
type Unit = { start: number; end: number; words: number; isHeading: boolean };
type Block = { start: number; end: number; heading: { level: number; text: string } | null };
type Section = { heading: string | null; units: Unit[] };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:\s|$)/;
const SENTENCE_GAP = /(?<=[.!?;·])\s+/g;

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function headingText(line: string): string {
  return line
    .replace(/^ {0,3}#{1,6}\s*/, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/^#+$/, "")
    .trim();
}

/**
 * Blocks of the Markdown: line runs separated by blank lines; a fenced code block (up to its closing fence or
 * the end) is one block; an ATX heading line is a block of its own.
 */
function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  let fence: string | null = null;
  const close = () => {
    if (current) blocks.push(current);
    current = null;
  };
  let pos = 0;
  for (const line of md.split("\n")) {
    const start = pos;
    const end = start + line.length;
    pos = end + 1;
    if (fence !== null) {
      current!.end = end;
      const m = line.match(FENCE);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) {
        fence = null;
        close();
      }
      continue;
    }
    if (line.trim() === "") {
      close();
      continue;
    }
    const fenceOpen = line.match(FENCE);
    if (fenceOpen) {
      close();
      current = { start, end, heading: null };
      fence = fenceOpen[1];
      continue;
    }
    const heading = line.match(ATX_HEADING);
    if (heading) {
      close();
      blocks.push({ start, end, heading: { level: heading[1].length, text: headingText(line) } });
      continue;
    }
    if (current) current.end = end;
    else current = { start, end, heading: null };
  }
  close();
  return blocks;
}

/** Word spans `[start, end)` of `text`, offsets relative to `offset`. */
function wordSpans(text: string, offset: number): Array<[number, number]> {
  return [...text.matchAll(/\S+/g)].map((m) => [offset + m.index, offset + m.index + m[0].length]);
}

/**
 * Units of one block: the block itself, or, above `maxWords`, sentences (`(?<=[.!?;·])\s+`) packed greedily into
 * pieces of at most `maxWords`; a sentence above `maxWords` is cut hard every `maxWords` words.
 */
function blockUnits(md: string, block: Block, maxWords: number): Unit[] {
  const text = md.slice(block.start, block.end);
  const words = countWords(text);
  if (words <= maxWords) return [{ start: block.start, end: block.end, words, isHeading: block.heading !== null }];

  const sentences: Unit[] = [];
  const addSentence = (from: number, to: number) => {
    const spans = wordSpans(md.slice(from, to), from);
    for (let i = 0; i < spans.length; i += maxWords) {
      const piece = spans.slice(i, i + maxWords);
      sentences.push({ start: piece[0][0], end: piece[piece.length - 1][1], words: piece.length, isHeading: false });
    }
  };
  let from = 0;
  for (const gap of text.matchAll(SENTENCE_GAP)) {
    addSentence(block.start + from, block.start + gap.index);
    from = gap.index + gap[0].length;
  }
  addSentence(block.start + from, block.end);

  const pieces: Unit[] = [];
  for (const s of sentences) {
    const last = pieces[pieces.length - 1];
    if (last && last.words + s.words <= maxWords) {
      last.end = s.end;
      last.words += s.words;
    } else pieces.push({ ...s });
  }
  return pieces;
}

function sections(md: string, maxWords: number): Section[] {
  const result: Section[] = [{ heading: null, units: [] }];
  for (const block of parseBlocks(md)) {
    if (block.heading && block.heading.level <= 3) result.push({ heading: block.heading.text || null, units: [] });
    result[result.length - 1].units.push(...blockUnits(md, block, maxWords));
  }
  return result.filter((s) => s.units.length > 0);
}

/**
 * Splits Markdown into chunks for extraction and embedding (spec 05: headings and paragraphs, target 500 words,
 * hard limit 800, overlap one paragraph). Works on the normalized Markdown. A level 1–3 heading starts a section:
 * the running chunk ends without overlap, the heading is the first block of the section and the `heading` of all its
 * chunks. Within a section blocks are collected; when the next block would push the chunk above `targetWords` and
 * the chunk already has a block of its own (a heading alone does not count unless the hard limit forces it), the chunk
 * closes and the next one starts with the last block of the previous one if that has at most `maxOverlapWords` words
 * and fits under `maxWords` together with the next block.
 */
export function chunkMarkdown(md: string, cfg: ChunkConfig): ChunkDraft[] {
  const normalized = normalizeMarkdown(md);
  const drafts: ChunkDraft[] = [];
  const emit = (units: Unit[], heading: string | null) => {
    const charStart = units[0].start;
    const charEnd = units[units.length - 1].end;
    const text = normalized.slice(charStart, charEnd);
    const textNormalized = normalizeText(text);
    drafts.push({
      ordinal: drafts.length,
      text,
      textNormalized,
      textHash: sha256Hex(textNormalized),
      heading,
      charStart,
      charEnd,
      wordCount: countWords(text),
    });
  };

  for (const section of sections(normalized, cfg.maxWords)) {
    let chunk: Unit[] = [];
    let overlap = 0;
    let total = 0;
    for (const unit of section.units) {
      const own = chunk.slice(overlap);
      const hasContent = own.some((u) => !u.isHeading);
      const close = (hasContent && total + unit.words > cfg.targetWords) || (own.length > 0 && total + unit.words > cfg.maxWords);
      if (close) {
        emit(chunk, section.heading);
        const last = chunk[chunk.length - 1];
        const carry = last.words <= cfg.maxOverlapWords && last.words + unit.words <= cfg.maxWords;
        chunk = carry ? [last] : [];
        overlap = chunk.length;
        total = carry ? last.words : 0;
      }
      chunk.push(unit);
      total += unit.words;
    }
    if (chunk.length > overlap) emit(chunk, section.heading);
  }
  return drafts;
}
