import { describe, expect, it } from "vitest";
import { isBorderline, orderRows, rowTier, summarize, toCsv, toMarkdown } from "../src/app/batch-utils";
import type { CheckItemResult, CheckResult } from "../src/lib/check";

const chunk = {
  chunkId: 1, ordinal: 7, heading: "H", text: "t", charStart: 0, charEnd: 1, score: 1,
  foundBy: ["embed", "keyword"] as ("embed" | "keyword")[], ranks: { embed: 2, keyword: 1 }, scores: { embed: 0.7, keyword: 9 },
};
type Ev = CheckResult["evidence"][number];
const ev = (stance: Ev["stance"], quote = "a quote"): Ev => ({ chunk: 1, stance, quote, chunkId: 1, quoteStart: 0, quoteEnd: 1 });
const verdict = (v: CheckResult["verdict"], extra: Partial<CheckResult> = {}): CheckResult => ({
  paperId: "arxiv:1", sentence: "s", retriever: "both", verdict: v, explanation: `because ${v}`,
  evidence: [ev("supports")], chunks: [chunk], grounded: true, modelCalls: 1, model: "m",
  usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0.02, ...extra,
});
const item = (results: CheckResult[], error: string | null = null): CheckItemResult => ({
  url: "u", sentence: "s", ingest: null, results, error, durationMs: 1,
});

const rows = [
  { result: item([verdict("relevant")]) },                       // 0
  { result: item([verdict("partially_relevant")]) },             // 1
  { result: item([verdict("relevant")]) },                       // 2
  { result: item([], "could not ingest paper: invalid URL") },   // 3 error
  { result: item([verdict("irrelevant")]) },                     // 4
  { result: item([verdict("relevant", { grounded: false })]) },  // 5 unverified
  { result: null },                                               // 6 still running
];

describe("orderRows", () => {
  it("sorts UNVERIFIED and ERROR first, then IRRELEVANT, PARTIALLY RELEVANT, RELEVANT; ties keep input order", () => {
    expect(orderRows(rows, "problems-first", "all")).toEqual([3, 5, 4, 1, 0, 2, 6]);
  });
  it("keeps input order as an option", () => {
    expect(orderRows(rows, "input-order", "all")).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it("filters to needs-attention and relevant-only", () => {
    expect(orderRows(rows, "problems-first", "needs-attention")).toEqual([3, 5, 4, 1]);
    expect(orderRows(rows, "input-order", "needs-attention")).toEqual([1, 3, 4, 5]);
    expect(orderRows(rows, "problems-first", "relevant-only")).toEqual([0, 2]);
  });
  it("ranks a side-by-side row by its worse verdict", () => {
    expect(rowTier(item([verdict("relevant"), verdict("irrelevant")]))).toBe(rowTier(item([verdict("irrelevant")])));
  });
});

describe("summarize", () => {
  it("counts each row once by its worst verdict", () => {
    expect(summarize(rows)).toBe("6 checked: 2 relevant, 1 partial, 1 irrelevant, 1 unverified, 1 error (1 still to run)");
    expect(summarize(rows.slice(0, 3))).toBe("3 checked: 2 relevant, 1 partial, 0 irrelevant");
  });
});

describe("isBorderline", () => {
  it("flags partial verdicts and relevant verdicts with a contradicting quote", () => {
    expect(isBorderline(verdict("partially_relevant"))).toBe(true);
    expect(isBorderline(verdict("relevant", { evidence: [ev("supports"), ev("contradicts")] }))).toBe(true);
    expect(isBorderline(verdict("relevant"))).toBe(false);
    expect(isBorderline(verdict("irrelevant", { evidence: [ev("contradicts")] }))).toBe(false);
  });
});

describe("exports", () => {
  const exportRows = [
    {
      sentence: "A | B claim\nwith a newline",
      url: "https://arxiv.org/abs/1",
      result: item([verdict("relevant", { explanation: 'x | "y"', evidence: [ev("supports", "fine"), ev("contradicts", 'but "no"')] })]),
    },
    { sentence: "fails", url: "not a url", result: item([], "could not ingest paper: invalid URL") },
  ];

  it("markdown: header, one escaped row per verdict, columns sentence/paper/verdict/explanation/top quote", () => {
    const lines = toMarkdown(exportRows).split("\n");
    expect(lines[0]).toBe("| Sentence | Paper | Verdict | Explanation | Top quote |");
    expect(lines).toHaveLength(4);
    const columns = (l: string) => l.split(/(?<!\\)\|/).length;
    for (const l of lines) expect(columns(l)).toBe(columns(lines[0]));
    // The contradicting quote leads under a RELEVANT verdict.
    expect(lines[2]).toBe('| A \\| B claim with a newline | https://arxiv.org/abs/1 | RELEVANT | x \\| "y" | contradicts: "but "no"" |');
    expect(lines[3]).toBe("| fails | not a url | ERROR | could not ingest paper: invalid URL |  |");
  });

  it("markdown labels unverified verdicts UNVERIFIED and side-by-side rows by retriever", () => {
    const md = toMarkdown([
      { sentence: "s", url: "u", result: item([verdict("relevant", { grounded: false })]) },
      { sentence: "t", url: "u", result: item([verdict("relevant", { retriever: "embed" }), verdict("irrelevant", { retriever: "keyword" })]) },
    ]);
    expect(md).toContain("| UNVERIFIED |");
    expect(md).toContain("| RELEVANT (embed) |");
    expect(md).toContain("| IRRELEVANT (keyword) |");
  });

  it("csv: same columns, quoted fields, doubled quotes, newlines kept inside the field", () => {
    const csv = toCsv(exportRows);
    expect(csv.split("\r\n")[0]).toBe('"Sentence","Paper","Verdict","Explanation","Top quote"');
    expect(csv).toContain('"A | B claim\nwith a newline","https://arxiv.org/abs/1","RELEVANT","x | ""y""","contradicts: ""but ""no"""""');
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});
