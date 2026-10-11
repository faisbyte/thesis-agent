"use client";

import { useEffect, useState } from "react";
import type { CheckItemResult, CheckResult, CheckRetriever } from "@/lib/check";
import type { PaperSummary } from "@/lib/db";
import { foundViaText, orderRows, toMarkdown, VERDICT_LABEL, verdictLabel, type BatchView } from "./batch-utils";

export default function Home() {
  const [papers, setPapers] = useState<PaperSummary[] | null>(null);
  const loadPapers = () =>
    fetch("/api/papers")
      .then((r) => r.json())
      .then((d) => setPapers(d.papers))
      .catch(() => setPapers([]));
  useEffect(() => {
    loadPapers();
  }, []);

  return (
    <main>
      <h1>Citation checker</h1>
      <p className="muted">
        Checks whether a sentence is supported by the paper it cites. Papers are ingested automatically the first time
        they're checked.
      </p>
      <PapersPanel papers={papers} />
      <SingleCheckPanel papers={papers ?? []} onIngested={loadPapers} />
      <BatchCheckPanel onIngested={loadPapers} />
    </main>
  );
}

// ---------------------------------------------------------------- papers

function PapersPanel({ papers }: { papers: PaperSummary[] | null }) {
  return (
    <section>
      <h2>Ingested papers</h2>
      {papers === null ? (
        <p className="muted">Loading…</p>
      ) : papers.length === 0 ? (
        <p className="muted">None yet. Run a check and the paper will be ingested.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Authors</th>
                <th>arXiv id / URL</th>
                <th className="num">Chunks</th>
                <th>Method</th>
                <th>Fetched</th>
              </tr>
            </thead>
            <tbody>
              {papers.map((p) => (
                <tr key={p.id}>
                  <td>{p.title ?? <span className="muted">(untitled)</span>}</td>
                  <td className="authors" title={p.authors ?? ""}>
                    {shortAuthors(p.authors)}
                  </td>
                  <td>
                    <a href={p.source_url} target="_blank" rel="noreferrer">
                      {p.arxiv_id ?? p.id}
                    </a>
                  </td>
                  <td className="num">{p.chunk_count}</td>
                  <td>{p.extraction_method === "failed" ? <span className="bad">failed</span> : p.extraction_method}</td>
                  <td className="nowrap">{p.fetched_at ? new Date(p.fetched_at).toLocaleString() : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function shortAuthors(authors: string | null): string {
  if (!authors) return "";
  const list = authors.split("; ");
  return list.length > 3 ? `${list.slice(0, 3).join("; ")} +${list.length - 3} more` : authors;
}

// ---------------------------------------------------------------- single check

async function postCheck(url: string, sentence: string, retriever: CheckRetriever): Promise<CheckItemResult> {
  try {
    const res = await fetch("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, sentence, retriever }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  } catch (err) {
    return { url, sentence, ingest: null, results: [], error: String(err instanceof Error ? err.message : err), durationMs: 0 };
  }
}

/**
 * Best-effort client-side guess at whether a URL is already stored, so the cost
 * is clear before submitting. The server decides for real (ingestPaper -> REUSED).
 */
function findStored(papers: PaperSummary[], url: string): PaperSummary | undefined {
  const u = url.trim().replace(/[#?].*$/, "").replace(/\/$/, "");
  if (!u) return undefined;
  return papers.find(
    (p) =>
      p.extraction_method !== "failed" &&
      (p.id === u ||
        p.source_url.replace(/\/$/, "") === u ||
        (p.arxiv_id !== null && new RegExp(`arxiv\\.org/(abs|pdf|html)/${p.arxiv_id.replace(".", "\\.")}(v\\d+)?(\\.pdf)?$`).test(u))),
  );
}

function SingleCheckPanel({ papers, onIngested }: { papers: PaperSummary[]; onIngested: () => void }) {
  const [url, setUrl] = useState("");
  const [sentence, setSentence] = useState("");
  const [retriever, setRetriever] = useState<CheckRetriever>("both");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CheckItemResult | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunning(true);
    setResult(null);
    const r = await postCheck(url, sentence, retriever);
    setResult(r);
    setRunning(false);
    if (r.ingest?.outcome === "FETCHED") onIngested();
  };

  return (
    <section>
      <h2>Check one sentence</h2>
      <form onSubmit={submit} className="stack">
        <label>
          Paper URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://arxiv.org/abs/2401.04088" required />
        </label>
        <label>
          Sentence
          <textarea value={sentence} onChange={(e) => setSentence(e.target.value)} rows={3} required />
        </label>
        <div className="row">
          <label className="inline">
            Retriever{" "}
            <select value={retriever} onChange={(e) => setRetriever(e.target.value as CheckRetriever)}>
              <option value="both">both, merged (default)</option>
              <option value="embed">embed only</option>
              <option value="keyword">keyword (BM25) only</option>
              <option value="side-by-side">embed and keyword side by side (2 model calls)</option>
            </select>
          </label>
          <button type="submit" disabled={running}>
            {running ? "Checking…" : "Check"}
          </button>
        </div>
      </form>
      {url.trim() && !running && <IngestHint stored={findStored(papers, url)} retriever={retriever} />}
      {running && <p className="muted">Working… a first-time paper is fetched and embedded before the model call.</p>}
      {result && <ItemResult item={result} />}
    </section>
  );
}

function IngestHint({ stored, retriever }: { stored: PaperSummary | undefined; retriever: CheckRetriever }) {
  const calls = retriever === "side-by-side" ? "2 model calls" : "1 model call";
  return stored ? (
    <p className="cost">
      <span className="tag">already stored</span> {stored.title ?? stored.id}, {stored.chunk_count} chunks. This check costs{" "}
      {calls} only (about $0.02 each).
    </p>
  ) : (
    <p className="cost">
      <span className="tag fresh">not stored yet</span> This check will first <strong>ingest the paper</strong> (fetched,
      extracted and embedded locally, free, a few seconds) and then make {calls} (billed, about $0.02 each).
    </p>
  );
}

// ---------------------------------------------------------------- batch check

const BATCH_EXAMPLE = "https://arxiv.org/abs/2401.04088 | Mixtral has the same architecture as Mistral 7B.";

interface BatchLine {
  line: number;
  url: string;
  sentence: string;
  parseError: string | null;
}

/** One check per line: "<url> | <sentence>" (or URL<TAB>sentence, as pasted from two spreadsheet columns). */
function parseBatch(text: string): BatchLine[] {
  const out: BatchLine[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const sep = line.includes(" | ") ? " | " : line.includes("\t") ? "\t" : null;
    if (!sep) {
      out.push({ line: i + 1, url: "", sentence: line, parseError: 'no separator: expected "<url> | <sentence>"' });
      return;
    }
    const at = line.indexOf(sep);
    out.push({ line: i + 1, url: line.slice(0, at).trim(), sentence: line.slice(at + sep.length).trim(), parseError: null });
  });
  return out;
}

function BatchCheckPanel({ onIngested }: { onIngested: () => void }) {
  const [text, setText] = useState("");
  const [retriever, setRetriever] = useState<CheckRetriever>("both");
  const [rows, setRows] = useState<{ input: BatchLine; result: CheckItemResult | null }[]>([]);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<BatchView>("problems-first");
  const [copied, setCopied] = useState<string | null>(null);
  const lines = parseBatch(text);

  const run = async () => {
    const initial = lines.map((input) => ({ input, result: null }));
    setRows(initial);
    setRunning(true);
    // One request per line, strictly in order, so progress is visible and nothing runs in parallel.
    let ingestedAny = false;
    for (let i = 0; i < lines.length; i++) {
      const input = lines[i];
      const result: CheckItemResult = input.parseError
        ? { url: input.url, sentence: input.sentence, ingest: null, results: [], error: input.parseError, durationMs: 0 }
        : await postCheck(input.url, input.sentence, retriever);
      if (result.ingest?.outcome === "FETCHED") ingestedAny = true;
      setRows((prev) => prev.map((row, j) => (j === i ? { ...row, result } : row)));
    }
    setRunning(false);
    if (ingestedAny) onIngested();
  };

  const finished = rows.filter((r) => r.result).length;
  const order = orderRows(rows, view);

  const copyMarkdown = async () => {
    const md = toMarkdown(order.map((i) => ({ line: i + 1, result: rows[i].result, sentence: rows[i].input.sentence, url: rows[i].input.url })));
    try {
      await navigator.clipboard.writeText(md);
      setCopied(`Copied ${order.length} row${order.length === 1 ? "" : "s"} as markdown.`);
    } catch {
      // Clipboard can be blocked; show the text so it can be copied by hand.
      setCopied(md);
    }
  };

  const totalCost = rows.reduce((sum, r) => sum + (r.result?.results.reduce((s, x) => s + x.costUsd, 0) ?? 0), 0);

  return (
    <section>
      <h2>Batch check</h2>
      <p className="muted">
        One check per line: <code>{"<paper URL> | <sentence>"}</code>. A tab between two pasted spreadsheet columns
        also works. Blank lines and lines starting with <code>#</code> are skipped. Example:
      </p>
      <pre className="example">{BATCH_EXAMPLE}</pre>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={BATCH_EXAMPLE}
        className="mono"
      />
      <div className="row">
        <label className="inline">
          Retriever{" "}
          <select value={retriever} onChange={(e) => setRetriever(e.target.value as CheckRetriever)}>
            <option value="both">both, merged (default)</option>
            <option value="embed">embed only</option>
            <option value="keyword">keyword (BM25) only</option>
            <option value="side-by-side">side by side (2 model calls per line)</option>
          </select>
        </label>
        <button onClick={run} disabled={running || lines.length === 0}>
          {running ? `Checking ${finished + 1} of ${rows.length}…` : `Check ${lines.length} line${lines.length === 1 ? "" : "s"}`}
        </button>
      </div>

      {rows.length > 0 && (
        <>
          <div className="row">
            <span className="muted">
              {finished} of {rows.length} done · estimated model cost so far ${totalCost.toFixed(4)}
            </span>
            <span>
              <label className="inline">
                Show{" "}
                <select value={view} onChange={(e) => setView(e.target.value as BatchView)}>
                  <option value="problems-first">problems first (errors, unverified, irrelevant, partial)</option>
                  <option value="problems-only">problems only</option>
                  <option value="input-order">all, in input order</option>
                </select>
              </label>{" "}
              <button onClick={copyMarkdown} disabled={running || finished === 0}>
                Copy as markdown
              </button>
            </span>
          </div>
          {copied && (copied.startsWith("|") ? <pre className="chunk">{copied}</pre> : <p className="muted">{copied}</p>)}
          <div className="scroll">
            <table className="batch">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Sentence</th>
                  <th>Paper</th>
                  <th>Verdict</th>
                  <th>Key evidence</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {order.map((i) => (
                  <BatchRow key={i} index={i + 1} input={rows[i].input} result={rows[i].result} pending={running && !rows[i].result && i === finished} />
                ))}
                {order.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No problem verdicts. Switch to “all” to see the {rows.length} relevant row{rows.length === 1 ? "" : "s"}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function BatchRow({ index, input, result, pending }: { index: number; input: BatchLine; result: CheckItemResult | null; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const first = result?.results[0];
  // Lead with a quote whose stance cuts against the verdict, if there is one: that's the informative case.
  const lead = first && (first.evidence.find((e) => isMismatch(first, e)) ?? first.evidence[0]);
  return (
    <>
      <tr className={result ? "clickable" : ""} onClick={() => result && setOpen(!open)}>
        <td className="num">{index}</td>
        <td title={input.sentence}>{truncate(input.sentence, 90)}</td>
        <td className="nowrap">{result?.ingest?.paperId ?? truncate(input.url, 40)}</td>
        <td>
          {!result ? (
            <span className="muted">{pending ? "running…" : "queued"}</span>
          ) : result.error ? (
            <span className="badge error">ERROR</span>
          ) : (
            result.results.map((r) => <VerdictBadge key={r.retriever} r={r} />)
          )}
        </td>
        <td>
          {result?.error ? (
            <span className="bad">{truncate(result.error, 80)}</span>
          ) : first && lead ? (
            <>
              <StanceTag stance={lead.stance} mismatch={isMismatch(first, lead)} /> “{truncate(lead.quote, 80)}”{" "}
              <ViaTags c={first.chunks[lead.chunk - 1]} />
            </>
          ) : first ? (
            <span className="muted">no quote</span>
          ) : null}
        </td>
        <td className="nowrap">{result && <CostSummary item={result} compact />}</td>
      </tr>
      {open && result && (
        <tr>
          <td colSpan={6} className="detail">
            <ItemResult item={result} />
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------- result display

function ItemResult({ item }: { item: CheckItemResult }) {
  return (
    <div className="result">
      <CostSummary item={item} />
      {item.error && <p className="bad">Error: {item.error}</p>}
      <div className={item.results.length > 1 ? "side-by-side" : ""}>
        {item.results.map((r) => (
          <VerdictDetail key={r.retriever} r={r} />
        ))}
      </div>
    </div>
  );
}

/** Makes the two kinds of cost visible: ingest (local, free) and the verify model call (billed). */
function CostSummary({ item, compact = false }: { item: CheckItemResult; compact?: boolean }) {
  const ingest = item.ingest;
  const paper =
    !ingest ? null : ingest.outcome === "FETCHED" ? (
      <span className="tag fresh" title="Fetched, extracted, chunked and embedded locally just now. No model cost.">
        new ingest {(ingest.durationMs / 1000).toFixed(1)}s
      </span>
    ) : ingest.outcome === "REUSED" ? (
      <span className="tag">already stored</span>
    ) : (
      <span className="tag bad">ingest failed</span>
    );
  const calls = item.results.reduce((s, r) => s + r.modelCalls, 0);
  const tokensIn = item.results.reduce((s, r) => s + r.usage.inputTokens, 0);
  const tokensOut = item.results.reduce((s, r) => s + r.usage.outputTokens, 0);
  const cost = item.results.reduce((s, r) => s + r.costUsd, 0);
  if (compact) {
    return (
      <>
        {paper} {item.results.length > 0 && <span className="muted">{calls === 0 ? "no model call" : `$${cost.toFixed(4)}`}</span>}
      </>
    );
  }
  return (
    <p className="cost">
      Paper: {paper ?? <span className="muted">not reached</span>}
      {ingest?.outcome === "FETCHED" && <span className="muted"> (local, free: {ingest.chunkCount} chunks via {ingest.method})</span>}
      {" · "}Verify:{" "}
      {item.results.length === 0 ? (
        <span className="muted">not run</span>
      ) : calls === 0 ? (
        <span>no model call (nothing retrieved)</span>
      ) : (
        <span>
          {calls} model call{calls === 1 ? "" : "s"}, {tokensIn.toLocaleString()} in / {tokensOut.toLocaleString()} out tokens, ≈ ${cost.toFixed(4)}
        </span>
      )}
      {" · "}
      <span className="muted">{(item.durationMs / 1000).toFixed(1)}s total</span>
    </p>
  );
}

function VerdictBadge({ r }: { r: CheckResult }) {
  if (!r.grounded) {
    return (
      <span className="badge unverified" title={`Model said ${VERDICT_LABEL[r.verdict]}, but a quote wasn't found in its chunk. Check by hand.`}>
        UNVERIFIED · {r.retriever}
      </span>
    );
  }
  return (
    <span className={`badge ${r.verdict}`}>
      {verdictLabel(r)} · {r.retriever}
    </span>
  );
}

function VerdictDetail({ r }: { r: CheckResult }) {
  return (
    <div className="verdict">
      <div>
        <VerdictBadge r={r} />
        <span className="muted">
          {" "}
          {RETRIEVER_LABEL[r.retriever]} · {r.chunks.length} chunks retrieved · {r.model ?? "no model call"}
        </span>
      </div>
      {!r.grounded && (
        <p className="bad">The model said {VERDICT_LABEL[r.verdict]}, but at least one quote isn't in the chunk it cites. Check by hand.</p>
      )}
      <p className="explanation">{r.explanation}</p>

      {r.evidence.length === 0 ? (
        <p className="muted">No evidence quoted.</p>
      ) : (
        r.evidence.map((e, i) => {
          const c = r.chunks[e.chunk - 1];
          const mismatch = isMismatch(r, e);
          return (
            <div key={i} className={`evidence ${e.stance}${mismatch ? " mismatch" : ""}`}>
              <div>
                <StanceTag stance={e.stance} mismatch={mismatch} /> <ViaTags c={c} />{" "}
                <span className="muted">“{c.heading ?? "no heading"}”</span>
              </div>
              <blockquote>{e.quote}</blockquote>
              <details>
                <summary>Show full evidence</summary>
                <p className="muted">
                  Chunk #{c.ordinal}, chars {c.charStart}–{c.charEnd}
                  {e.quoteStart !== null ? `, quote at chars ${e.quoteStart}–${e.quoteEnd}` : ", quote NOT found in chunk"} · scores:{" "}
                  <FoundVia c={c} />
                </p>
                <ChunkText text={c.text} charStart={c.charStart} quoteStart={e.quoteStart} quoteEnd={e.quoteEnd} />
              </details>
            </div>
          );
        })
      )}

      <details>
        <summary>All {r.chunks.length} retrieved chunks (including ones not cited)</summary>
        <ol className="chunks">
          {r.chunks.map((c) => (
            <li key={c.chunkId}>
              <span className="muted">
                <FoundVia c={c} /> · #{c.ordinal} “{c.heading ?? ""}” · chars {c.charStart}–{c.charEnd}
              </span>
              <details>
                <summary>{truncate(c.text.replace(/\s+/g, " "), 120)}</summary>
                <ChunkText text={c.text} charStart={c.charStart} quoteStart={null} quoteEnd={null} />
              </details>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/** A supporting quote under an IRRELEVANT verdict, or a contradicting one under RELEVANT. */
function isMismatch(r: CheckResult, e: CheckResult["evidence"][number]): boolean {
  return (r.verdict === "relevant" && e.stance === "contradicts") || (r.verdict === "irrelevant" && e.stance === "supports");
}

function StanceTag({ stance, mismatch }: { stance: "supports" | "contradicts"; mismatch: boolean }) {
  return (
    <span
      className={`stance ${stance}${mismatch ? " mismatch" : ""}`}
      title={mismatch ? "This quote's stance cuts against the overall verdict. Worth a look." : undefined}
    >
      {stance === "supports" ? "✓ supports" : "✗ contradicts"}
      {mismatch && " ⚠"}
    </span>
  );
}

/** Compact found-via tags for a cited chunk: "embed #2", "keyword #1". */
function ViaTags({ c }: { c: CheckResult["chunks"][number] }) {
  return (
    <span title={`found via ${foundViaText(c)}`}>
      {c.foundBy.map((s) => (
        <span key={s} className={`tag via-${s}`}>
          {s} #{c.ranks[s]}
        </span>
      ))}
    </span>
  );
}

const RETRIEVER_LABEL = {
  both: "merged embed + keyword",
  embed: "embedding (bge-small)",
  keyword: "keyword (BM25)",
} as const;

/** Which retriever(s) surfaced a chunk, with rank and score from each. */
function FoundVia({ c }: { c: CheckResult["chunks"][number] }) {
  return (
    <>
      {c.foundBy.map((s, i) => (
        <span key={s}>
          {i > 0 && ", "}
          <span className={`tag via-${s}`}>{s}</span> #{c.ranks[s]} ({c.scores[s]!.toFixed(s === "embed" ? 3 : 2)})
        </span>
      ))}
    </>
  );
}

/** Full chunk text, with the quoted span highlighted when we located it. */
function ChunkText({ text, charStart, quoteStart, quoteEnd }: { text: string; charStart: number; quoteStart: number | null; quoteEnd: number | null }) {
  if (quoteStart === null || quoteEnd === null) return <pre className="chunk">{text}</pre>;
  const a = quoteStart - charStart;
  const b = quoteEnd - charStart;
  return (
    <pre className="chunk">
      {text.slice(0, a)}
      <mark>{text.slice(a, b)}</mark>
      {text.slice(b)}
    </pre>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
