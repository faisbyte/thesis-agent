import { config } from "./config";

export interface Chunk {
  ordinal: number;
  heading: string | null;
  text: string; // always === extractedText.slice(charStart, charEnd)
  charStart: number;
  charEnd: number;
}

interface Span {
  start: number;
  end: number;
}

const ABBREVIATIONS = new Set([
  "e.g", "i.e", "al", "etc", "vs", "cf", "fig", "figs", "eq", "eqs", "sec", "secs",
  "tab", "ref", "refs", "no", "approx", "resp", "dr", "mr", "ms", "prof", "st", "vol", "pp",
]);

/**
 * Split extracted text into chunks of roughly chunkMinChars..chunkMaxChars,
 * packing whole paragraphs and starting a new chunk at each "## " heading.
 * Paragraphs are split between sentences when needed, never inside one
 * (a single sentence longer than the max becomes its own chunk).
 */
export function chunkText(text: string, opts = { min: config.chunkMinChars, max: config.chunkMaxChars }): Chunk[] {
  const chunks: Chunk[] = [];
  let heading: string | null = null;
  let current: Span | null = null;

  const flush = () => {
    if (!current) return;
    chunks.push({
      ordinal: chunks.length,
      heading,
      text: text.slice(current.start, current.end),
      charStart: current.start,
      charEnd: current.end,
    });
    current = null;
  };

  for (const para of paragraphSpans(text)) {
    const paraText = text.slice(para.start, para.end);
    if (paraText.startsWith("## ")) {
      flush();
      heading = paraText.slice(3).trim();
      continue;
    }
    // Break a paragraph into sentences when it's too long on its own, or when the
    // current chunk is still under min and the whole paragraph won't fit.
    const tooLong = para.end - para.start > opts.max;
    const wontFit: boolean = current !== null && current.end - current.start < opts.min && para.end - current.start > opts.max;
    const units: Span[] = tooLong || wontFit ? sentenceSpans(text, para) : [para];
    for (const unit of units) {
      if (current && unit.end - current.start > opts.max) flush();
      current = current ? { start: current.start, end: unit.end } : { ...unit };
    }
  }
  flush();
  return chunks;
}

/** Non-empty runs of text separated by blank lines, as offsets into `text`. */
export function paragraphSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = /\S[\s\S]*?(?=\n[ \t]*\n|\s*$)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/** Sentence spans within a paragraph span. Boundaries: [.!?] + space + capital/digit/opening bracket. */
export function sentenceSpans(text: string, para: Span): Span[] {
  const spans: Span[] = [];
  const re = /[.!?]["')\]]?(\s+)(?=[A-Z0-9(\["\u201C])/g;
  re.lastIndex = para.start;
  let start = para.start;
  for (let m = re.exec(text); m && m.index < para.end; m = re.exec(text)) {
    const end = m.index + m[0].length - m[1].length; // end after the punctuation
    const word = text.slice(start, m.index + 1).match(/(\S+)\.$/)?.[1]?.toLowerCase();
    if (word && (ABBREVIATIONS.has(word) || /^[a-z]$/i.test(word))) continue; // "et al.", "Fig.", initials
    spans.push({ start, end });
    start = m.index + m[0].length;
  }
  if (start < para.end) spans.push({ start, end: para.end });
  return spans;
}
