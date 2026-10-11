import { describe, expect, it } from "vitest";
import { chunkText, sentenceSpans } from "../src/lib/chunk";
import { extractArxivHtml } from "../src/lib/extract";
import { fixture } from "./helpers";

const sentence = (i: number) => `Sentence number ${i} talks about results in some detail, e.g. accuracy and recall.`;
const paragraph = (from: number, count: number) => Array.from({ length: count }, (_, i) => sentence(from + i)).join(" ");

describe("chunkText", () => {
  const text = [
    "## Introduction",
    paragraph(0, 4),
    paragraph(4, 5),
    paragraph(9, 20), // longer than max: must be split between sentences
    "## Results",
    paragraph(29, 3),
  ].join("\n\n");
  const chunks = chunkText(text);

  it("offsets round-trip exactly", () => {
    for (const c of chunks) expect(text.slice(c.charStart, c.charEnd)).toBe(c.text);
  });

  it("stays within the size bounds and never splits a sentence", () => {
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1000);
      expect(c.text).toMatch(/^Sentence number \d+/);
      expect(c.text).toMatch(/recall\.$/);
    }
    // Everything except section-final chunks reaches the minimum.
    const sectionFinal = new Set(chunks.filter((c, i) => chunks[i + 1]?.heading !== c.heading).map((c) => c.ordinal));
    for (const c of chunks) if (!sectionFinal.has(c.ordinal)) expect(c.text.length).toBeGreaterThanOrEqual(600);
  });

  it("covers every sentence exactly once, in order", () => {
    const joined = chunks.map((c) => c.text.replace(/\s+/g, " ")).join(" ");
    expect(joined).toBe([paragraph(0, 4), paragraph(4, 5), paragraph(9, 20), paragraph(29, 3)].join(" "));
  });

  it("assigns headings and starts a new chunk at each heading", () => {
    expect(chunks[0].heading).toBe("Introduction");
    expect(chunks.at(-1)!.heading).toBe("Results");
    expect(chunks.at(-1)!.text).toBe(paragraph(29, 3));
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it("works with no headings", () => {
    const plain = [paragraph(0, 3), paragraph(3, 3)].join("\n\n");
    const cs = chunkText(plain);
    expect(cs.every((c) => c.heading === null)).toBe(true);
    for (const c of cs) expect(plain.slice(c.charStart, c.charEnd)).toBe(c.text);
  });

  it("round-trips on extracted arxiv HTML", () => {
    const { text } = extractArxivHtml(fixture("arxiv-paper.html").toString())!;
    const cs = chunkText(text);
    expect(cs.length).toBeGreaterThan(2);
    for (const c of cs) expect(text.slice(c.charStart, c.charEnd)).toBe(c.text);
    expect(cs.map((c) => c.heading)).toContain("2.1 Retrieval");
  });
});

describe("sentenceSpans", () => {
  it("does not split on common abbreviations", () => {
    const t = "As shown by Smith et al. in Fig. 2, results improve. A second sentence follows.";
    const spans = sentenceSpans(t, { start: 0, end: t.length }).map((s) => t.slice(s.start, s.end));
    expect(spans).toEqual(["As shown by Smith et al. in Fig. 2, results improve.", "A second sentence follows."]);
  });
});
