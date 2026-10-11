// Pure helpers for the batch results table: verdict ordering and markdown export.
// Kept out of page.tsx so they can be unit-tested.
import type { CheckItemResult, CheckResult } from "@/lib/check";

export const VERDICT_LABEL = {
  relevant: "RELEVANT",
  partially_relevant: "PARTIALLY RELEVANT",
  irrelevant: "IRRELEVANT",
} as const;

/** The label shown on a verdict badge: UNVERIFIED overrides the model's verdict when a quote wasn't located. */
export function verdictLabel(r: CheckResult): string {
  return r.grounded ? VERDICT_LABEL[r.verdict] : "UNVERIFIED";
}

/** Lower = needs attention sooner. Errors and unverified first, relevant last. */
function severity(r: CheckResult): number {
  if (!r.grounded) return 1;
  return { irrelevant: 2, partially_relevant: 3, relevant: 4 }[r.verdict];
}

/** Severity of a whole row: its worst verdict (side-by-side rows have two). Pending rows sort last. */
export function rowSeverity(result: CheckItemResult | null): number {
  if (!result) return 9;
  if (result.error || result.results.length === 0) return 0;
  return Math.min(...result.results.map(severity));
}

export type BatchView = "problems-first" | "problems-only" | "input-order";

/** Indices into `rows` in display order for the chosen view. Ties keep input order. */
export function orderRows(rows: { result: CheckItemResult | null }[], view: BatchView): number[] {
  const indices = rows.map((_, i) => i);
  if (view === "input-order") return indices;
  const sorted = indices.sort((a, b) => rowSeverity(rows[a].result) - rowSeverity(rows[b].result) || a - b);
  if (view === "problems-only") return sorted.filter((i) => rowSeverity(rows[i].result) < 4);
  return sorted;
}

/** "embed #2 + keyword #1" for a chunk. */
export function foundViaText(c: CheckResult["chunks"][number]): string {
  return c.foundBy.map((s) => `${s} #${c.ranks[s]}`).join(" + ");
}

/** Escape a value for a markdown table cell: pipes and newlines would break the row. */
function cell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

/** Markdown table of batch results, one row per verdict, in the order given. */
export function toMarkdown(rows: { line: number; result: CheckItemResult | null; sentence: string; url: string }[]): string {
  const header = ["#", "Verdict", "Sentence", "Paper", "Evidence (stance, found via)", "Explanation"];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  for (const row of rows) {
    const r = row.result;
    if (!r) {
      lines.push(`| ${row.line} | (not run) | ${cell(row.sentence)} | ${cell(row.url)} |  |  |`);
      continue;
    }
    if (r.error || r.results.length === 0) {
      lines.push(`| ${row.line} | ERROR | ${cell(row.sentence)} | ${cell(r.ingest?.paperId ?? row.url)} |  | ${cell(r.error ?? "")} |`);
      continue;
    }
    for (const v of r.results) {
      const evidence = v.evidence
        .map((e) => `${e.stance === "supports" ? "\u2713" : "\u2717"} \u201C${e.quote}\u201D (chunk #${v.chunks[e.chunk - 1].ordinal}, ${foundViaText(v.chunks[e.chunk - 1])})`)
        .join("; ");
      lines.push(
        `| ${row.line} | ${verdictLabel(v)} (${v.retriever}) | ${cell(row.sentence)} | ${cell(r.ingest?.paperId ?? row.url)} | ${cell(evidence || "none quoted")} | ${cell(v.explanation)} |`,
      );
    }
  }
  return lines.join("\n");
}
