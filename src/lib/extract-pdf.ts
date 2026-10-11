import { PDFParse } from "pdf-parse";
import type { Extracted } from "./extract";

/**
 * PDF -> text in the same conventions as extract.ts: blank line between
 * paragraphs, headings on their own "## " line.
 *
 * pdf-parse gives us one line per visual line with no paragraph structure,
 * so paragraphs are rebuilt heuristically: a line that ends a sentence and is
 * noticeably shorter than the page's typical line closes a paragraph.
 */
export async function extractPdf(data: Uint8Array): Promise<Extracted> {
  const parser = new PDFParse({ data });
  try {
    const info = await parser.getInfo().catch(() => null);
    const result = await parser.getText({ pageJoiner: "" });
    const paragraphs = result.pages.flatMap((page) => pageToParagraphs(page.text));
    const text = mergeAcrossPages(paragraphs).join("\n\n");
    const infoTitle = typeof info?.info?.Title === "string" ? info.info.Title.trim() : "";
    return { text, title: infoTitle || null };
  } finally {
    await parser.destroy();
  }
}

/**
 * Short line, no lowercase letters, mostly letters: "ABSTRACT", "2 RELATED WORK".
 * The mostly-letters rule rejects report numbers ("HUTP-97/A097") and math ("N − M + MU4").
 */
export function isAllCapsHeading(line: string): boolean {
  if (line.length > 60) return false;
  const letters = line.replace(/[^A-Za-z]/g, "");
  const nonSpace = line.replace(/\s/g, "");
  return (
    letters.length >= 4 &&
    letters === letters.toUpperCase() &&
    letters.length / nonSpace.length >= 0.7 &&
    !/[.,;]$/.test(line)
  );
}

/** Numbered section title: "1 Introduction", "3.2 Training Setup". */
function isNumberedHeading(line: string, typicalLen: number): boolean {
  return (
    line.length <= 60 &&
    line.length < typicalLen * 0.7 &&
    /^\d{1,2}(\.\d{1,2}){0,2}\.?\s+[A-Z][A-Za-z-]+(\s+[A-Za-z-:&]+){0,7}$/.test(line)
  );
}

function isNoise(line: string): boolean {
  return (
    /^\d{1,4}$/.test(line) || // page numbers
    /^arXiv:(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?\s/.test(line) // arxiv side stamp
  );
}

function pageToParagraphs(pageText: string): string[] {
  const lines = pageText
    .split("\n")
    .map((l) => l.replace(/\t/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l && !isNoise(l));
  if (lines.length === 0) return [];

  const lengths = lines.map((l) => l.length).sort((a, b) => a - b);
  const typicalLen = lengths[Math.floor(lengths.length * 0.8)];

  const paragraphs: string[] = [];
  let current = "";
  const flush = () => {
    if (current) paragraphs.push(current);
    current = "";
  };

  for (const line of lines) {
    if (isAllCapsHeading(line) || isNumberedHeading(line, typicalLen)) {
      flush();
      paragraphs.push("## " + line);
      continue;
    }
    current = joinLine(current, line);
    const endsSentence = /[.!?:]["')\]]?$/.test(line);
    if (endsSentence && line.length < typicalLen * 0.85) flush();
  }
  flush();
  return paragraphs;
}

/** Join wrapped lines, undoing end-of-line hyphenation ("transfor-" + "mer"). */
function joinLine(current: string, line: string): string {
  if (!current) return line;
  if (/[a-z]-$/.test(current) && /^[a-z]/.test(line)) return current.slice(0, -1) + line;
  return current + " " + line;
}

/** A paragraph split by a page break continues if the previous one didn't end a sentence. */
function mergeAcrossPages(paragraphs: string[]): string[] {
  const out: string[] = [];
  for (const p of paragraphs) {
    const prev = out[out.length - 1];
    if (prev && !prev.startsWith("## ") && !p.startsWith("## ") && !/[.!?:]["')\]]?$/.test(prev) && /^[a-z]/.test(p)) {
      out[out.length - 1] = joinLine(prev, p);
    } else {
      out.push(p);
    }
  }
  return out;
}
