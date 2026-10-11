import { describe, expect, it } from "vitest";
import { orderRows, rowSeverity, toMarkdown } from "../src/app/batch-utils";
import type { CheckItemResult, CheckResult } from "../src/lib/check";

const chunk = { chunkId: 1, ordinal: 7, heading: "H", text: "t", charStart: 0, charEnd: 1, score: 1, foundBy: ["embed", "keyword"] as ("embed" | "keyword")[], ranks: { embed: 2, keyword: 1 }, scores: { embed: 0.7, keyword: 9 } };
const verdict = (v: CheckResult["verdict"], extra: Partial<CheckResult> = {}): CheckResult => ({
  paperId: "arxiv:1", sentence: "s", retriever: "both", verdict: v, explanation: `because ${v}`,
  evidence: [{ chunk: 1, stance: "supports", quote: "a quote", chunkId: 1, quoteStart: 0, quoteEnd: 1 }],
  chunks: [chunk], grounded: true, modelCalls: 1, model: "m", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0.02, ...extra,
});
const item = (results: CheckResult[], error: string | null = null): CheckItemResult => ({
  url: "u", sentence: "s", ingest: null, results, error, durationMs: 1,
});

const rows = [
  { result: item([verdict("relevant")]) },          // 0
  { result: item([verdict("partially_relevant")]) }, // 1
  { result: item([verdict("relevant")]) },          // 2
  { result: item([], "bad URL") },                  // 3
  { result: item([verdict("irrelevant")]) },        // 4
  { result: item([verdict("relevant", { grounded: false })]) }, // 5: unverified
  { result: null },                                  // 6: still running
];

describe("orderRows", () => {
  it("puts problems first: error, unverified, irrelevant, partial, then relevant, then pending", () => {
    expect(orderRows(rows, "problems-first")).toEqual([3, 5, 4, 1, 0, 2, 6]);
  });
  it("can show only problems", () => {
    expect(orderRows(rows, "problems-only")).toEqual([3, 5, 4, 1]);
  });
  it("can keep input order", () => {
    expect(orderRows(rows, "input-order")).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it("ranks a side-by-side row by its worse verdict", () => {
    expect(rowSeverity(item([verdict("relevant"), verdict("irrelevant")]))).toBe(rowSeverity(item([verdict("irrelevant")])));
  });
});

describe("toMarkdown", () => {
  it("escapes pipes and newlines so each result stays one table row", () => {
    const md = toMarkdown([
      { line: 1, sentence: "A | B claim\nwith a newline", url: "u", result: item([verdict("partially_relevant", { explanation: "x | y" })]) },
      { line: 2, sentence: "fails", url: "not a url", result: item([], "could not ingest paper: invalid URL") },
    ]);
    const lines = md.split("\n");
    expect(lines).toHaveLength(4); // header, separator, 2 rows
    const columns = (l: string) => l.split(/(?<!\\)\|/).length;
    for (const l of lines) expect(columns(l)).toBe(columns(lines[0]));
    expect(lines[2]).toContain("A \\| B claim with a newline");
    expect(lines[2]).toContain("PARTIALLY RELEVANT (both)");
    expect(lines[2]).toContain("chunk #7, embed #2 + keyword #1");
    expect(lines[3]).toContain("| ERROR |");
  });

  it("labels unverified verdicts as UNVERIFIED, not the model's verdict", () => {
    const md = toMarkdown([{ line: 1, sentence: "s", url: "u", result: item([verdict("relevant", { grounded: false })]) }]);
    expect(md).toContain("UNVERIFIED (both)");
    expect(md).not.toContain("| RELEVANT");
  });
});
