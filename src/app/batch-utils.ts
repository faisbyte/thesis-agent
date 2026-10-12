// Pure helpers for the results display: verdict ordering, filtering, summary and export.
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

/** PARTIALLY RELEVANT, or RELEVANT with at least one contradicting quote: worth a second look. */
export function isBorderline(r: CheckResult): boolean {
  return r.verdict === "partially_relevant" || (r.verdict === "relevant" && r.evidence.some((e) => e.stance === "contradicts"));
}

// Sort tiers: needs attention first.
const TIER = { attention: 0, irrelevant: 1, partial: 2, relevant: 3, pending: 9 } as const;

function verdictTier(r: CheckResult): number {
  if (!r.grounded) return TIER.attention;
  return { irrelevant: TIER.irrelevant, partially_relevant: TIER.partial, relevant: TIER.relevant }[r.verdict];
}

/** A row's tier is its worst verdict (side-by-side rows have two). ERROR and UNVERIFIED share the top tier. */
export function rowTier(result: CheckItemResult | null): number {
  if (!result) return TIER.pending;
  if (result.error || result.results.length === 0) return TIER.attention;
  return Math.min(...result.results.map(verdictTier));
}

export type BatchSort = "problems-first" | "input-order";
export type BatchFilter = "all" | "needs-attention" | "relevant-only";

/** Indices into `rows` in display order. Ties keep input order. Pending rows only show under "all". */
export function orderRows(rows: { result: CheckItemResult | null }[], sort: BatchSort, filter: BatchFilter): number[] {
  let indices = rows.map((_, i) => i);
  if (filter === "needs-attention") indices = indices.filter((i) => rowTier(rows[i].result) < TIER.relevant);
  if (filter === "relevant-only") indices = indices.filter((i) => rowTier(rows[i].result) === TIER.relevant);
  if (sort === "problems-first") indices.sort((a, b) => rowTier(rows[a].result) - rowTier(rows[b].result) || a - b);
  return indices;
}

/** "12 checked: 7 relevant, 3 partial, 1 irrelevant, 1 error" (plus unverified / running when present). */
export function summarize(rows: { result: CheckItemResult | null }[]): string {
  const count = { relevant: 0, partial: 0, irrelevant: 0, unverified: 0, error: 0, pending: 0 };
  for (const { result } of rows) {
    if (!result) count.pending++;
    else if (result.error || result.results.length === 0) count.error++;
    else if (result.results.some((r) => !r.grounded)) count.unverified++;
    else {
      const tier = rowTier(result);
      if (tier === TIER.irrelevant) count.irrelevant++;
      else if (tier === TIER.partial) count.partial++;
      else count.relevant++;
    }
  }
  const parts = [`${count.relevant} relevant`, `${count.partial} partial`, `${count.irrelevant} irrelevant`];
  if (count.unverified) parts.push(`${count.unverified} unverified`);
  if (count.error) parts.push(`${count.error} error${count.error === 1 ? "" : "s"}`);
  const head = `${rows.length - count.pending} checked: ${parts.join(", ")}`;
  return count.pending ? `${head} (${count.pending} still to run)` : head;
}

/** "embed #2 + keyword #1" for a chunk. */
export function foundViaText(c: CheckResult["chunks"][number]): string {
  return c.foundBy.map((s) => `${s} #${c.ranks[s]}`).join(" + ");
}

/** The quote to lead with: one whose stance cuts against the verdict if there is one, else the first. */
export function topQuote(r: CheckResult): CheckResult["evidence"][number] | undefined {
  const mismatch = r.evidence.find(
    (e) => (r.verdict === "relevant" && e.stance === "contradicts") || (r.verdict === "irrelevant" && e.stance === "supports"),
  );
  return mismatch ?? r.evidence[0];
}

export interface ExportRow {
  sentence: string;
  url: string;
  result: CheckItemResult | null;
}

/** One record per verdict: Sentence, Paper, Verdict, Explanation, Top quote. Side-by-side rows give two, labelled by retriever. */
function exportRecords(rows: ExportRow[]): string[][] {
  const records: string[][] = [];
  for (const { sentence, url, result } of rows) {
    const paper = result?.ingest?.paperId ?? url;
    if (!result) {
      records.push([sentence, paper, "NOT RUN", "", ""]);
    } else if (result.error || result.results.length === 0) {
      records.push([sentence, paper, "ERROR", result.error ?? "", ""]);
    } else {
      for (const r of result.results) {
        const q = topQuote(r);
        const verdict = verdictLabel(r) + (result.results.length > 1 ? ` (${r.retriever})` : "");
        records.push([sentence, paper, verdict, r.explanation, q ? `${q.stance}: "${q.quote}"` : ""]);
      }
    }
  }
  return records;
}

const EXPORT_HEADER = ["Sentence", "Paper", "Verdict", "Explanation", "Top quote"];

/** Escape a markdown table cell: pipes and newlines would break the row. */
function mdCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

export function toMarkdown(rows: ExportRow[]): string {
  const lines = [`| ${EXPORT_HEADER.join(" | ")} |`, `|${EXPORT_HEADER.map(() => "---").join("|")}|`];
  for (const rec of exportRecords(rows)) lines.push(`| ${rec.map(mdCell).join(" | ")} |`);
  return lines.join("\n");
}

/** RFC 4180 CSV: every field quoted, inner quotes doubled, CRLF line ends. */
export function toCsv(rows: ExportRow[]): string {
  const field = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return [EXPORT_HEADER, ...exportRecords(rows)].map((rec) => rec.map(field).join(",")).join("\r\n") + "\r\n";
}
