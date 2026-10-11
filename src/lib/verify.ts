import { config } from "./config";
import { getStoredPaper, type DB } from "./db";
import { anthropicModel, type ModelFn, type ModelMessage } from "./model";
import { buildUserPrompt, SYSTEM_PROMPT, VERDICT_SCHEMA, VERDICTS, type Verdict } from "./prompt";
import { retrieveKeyword, type RetrievedChunk } from "./retrieve-keyword";
import { retrieveEmbed, type Embedder } from "./retrieve-embed";

/** "both" runs keyword and embedding retrieval and merges their chunks into one evidence set. */
export type RetrieverName = "keyword" | "embed" | "both";

/** A retrieved chunk plus which retriever(s) surfaced it and at what rank (1-based). */
export interface EvidenceChunk extends RetrievedChunk {
  foundBy: ("embed" | "keyword")[];
  ranks: { embed?: number; keyword?: number };
  scores: { embed?: number; keyword?: number };
}

export interface EvidenceItem {
  chunk: number; // 1-based position in `chunks`
  stance: "supports" | "contradicts";
  quote: string; // as the model gave it
  chunkId: number;
  /** Exact span of the quote in papers.extracted_text, or null if it wasn't found in the chunk. */
  quoteStart: number | null;
  quoteEnd: number | null;
}

export interface VerifyResult {
  paperId: string;
  sentence: string;
  retriever: RetrieverName;
  verdict: Verdict;
  explanation: string;
  evidence: EvidenceItem[];
  chunks: EvidenceChunk[];
  /**
   * True when every quote was found in the chunk it cites, and a relevant /
   * partially_relevant verdict has at least one located supporting quote.
   * False means the verdict rests on text we couldn't find: check it by hand.
   */
  grounded: boolean;
  modelCalls: number;
  model: string | null;
  /** Tokens across all model calls for this check (including a retry). */
  usage: { inputTokens: number; outputTokens: number };
}

export class VerificationError extends Error {
  constructor(
    message: string,
    readonly rawReplies: string[],
  ) {
    super(message);
  }
}

export interface VerifyOptions {
  db: DB;
  paper: string; // paper id or any URL form of it
  sentence: string;
  retriever: RetrieverName;
  embedder?: Embedder; // required for retriever "embed" and "both"
  model?: ModelFn;
  /** Chunks taken from each retriever. */
  limit?: number;
  /** Cap on the merged set for retriever "both". */
  maxMerged?: number;
}

/** retrieve -> prompt -> model -> validate. Throws PaperNotFoundError, ModelError or VerificationError. */
export async function verifyCitation(opts: VerifyOptions): Promise<VerifyResult> {
  const { db, sentence, retriever } = opts;
  const paper = getStoredPaper(db, opts.paper);
  const limit = opts.limit ?? config.retrieveLimit;

  if (retriever !== "keyword" && !opts.embedder) throw new Error(`retriever '${retriever}' needs an embedder`);
  const embedList = retriever === "keyword" ? [] : await retrieveEmbed(db, paper.id, sentence, opts.embedder!, limit);
  const keywordList = retriever === "embed" ? [] : retrieveKeyword(db, paper.id, sentence, limit);
  const chunks = mergeChunks(embedList, keywordList, opts.maxMerged ?? config.mergedMaxChunks);

  const base = { paperId: paper.id, sentence, retriever, chunks };

  // Nothing to judge against: don't pay for a model call.
  if (chunks.length === 0) {
    return {
      ...base,
      verdict: "irrelevant",
      explanation: `${retriever === "both" ? "Neither retriever" : `The ${retriever} retriever`} found no chunks in this paper matching the sentence, so there is no evidence to check it against.`,
      evidence: [],
      grounded: true,
      modelCalls: 0,
      model: null,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const callModel = opts.model ?? anthropicModel();
  const messages: ModelMessage[] = [{ role: "user", content: buildUserPrompt(sentence, chunks, paper.title) }];
  const replies: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await callModel({ system: SYSTEM_PROMPT, messages, schema: VERDICT_SCHEMA });
    replies.push(res.text);
    usage.inputTokens += res.usage?.inputTokens ?? 0;
    usage.outputTokens += res.usage?.outputTokens ?? 0;
    const parsed = res.stopReason === "max_tokens" ? { error: "reply was cut off (max_tokens)" } : parseReply(res.text, chunks.length);

    if ("value" in parsed) {
      const evidence = parsed.value.evidence.map((e) => locateQuote(e, chunks[e.chunk - 1]));
      const allLocated = evidence.every((e) => e.quoteStart !== null);
      const hasLocatedSupport = evidence.some((e) => e.stance === "supports" && e.quoteStart !== null);
      return {
        ...base,
        verdict: parsed.value.verdict,
        explanation: parsed.value.explanation,
        evidence,
        grounded: allLocated && (parsed.value.verdict === "irrelevant" || hasLocatedSupport),
        modelCalls: attempt,
        model: res.model,
        usage,
      };
    }

    // Show the model its rejected reply and why, then ask once more.
    messages.push(
      { role: "assistant", content: res.text || "(empty reply)" },
      { role: "user", content: `That reply was rejected: ${parsed.error}. Reply again with only the JSON object.` },
    );
    if (attempt === 2) {
      throw new VerificationError(`model reply invalid after one retry: ${parsed.error}`, replies);
    }
  }
  throw new Error("unreachable");
}

/**
 * Union of two ranked lists, deduplicated by chunk id. Chunks are taken in
 * rank order, alternating embed then keyword (embed #1, keyword #1, embed #2,
 * ...), so if the cap bites, each retriever's best chunks survive. Each chunk
 * records which retriever(s) found it.
 */
export function mergeChunks(embed: RetrievedChunk[], keyword: RetrievedChunk[], max: number): EvidenceChunk[] {
  const byId = new Map<number, EvidenceChunk>();
  const add = (c: RetrievedChunk, source: "embed" | "keyword", rank: number) => {
    const existing = byId.get(c.chunkId);
    if (existing) {
      existing.foundBy.push(source);
      existing.ranks[source] = rank;
      existing.scores[source] = c.score;
      return;
    }
    if (byId.size >= max) return;
    byId.set(c.chunkId, { ...c, foundBy: [source], ranks: { [source]: rank }, scores: { [source]: c.score } });
  };
  for (let i = 0; i < Math.max(embed.length, keyword.length); i++) {
    if (embed[i]) add(embed[i], "embed", i + 1);
    if (keyword[i]) add(keyword[i], "keyword", i + 1);
  }
  // Stable tag order for display, whichever retriever reached the chunk first.
  for (const c of byId.values()) c.foundBy.sort();
  return [...byId.values()];
}

interface ParsedReply {
  verdict: Verdict;
  explanation: string;
  evidence: { chunk: number; quote: string; stance: "supports" | "contradicts" }[];
}

/** Strict validation of the model's JSON. Returns a reason on any problem rather than guessing. */
export function parseReply(text: string, chunkCount: number): { value: ParsedReply } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "not valid JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { error: "not a JSON object" };
  const { verdict, explanation, evidence } = data as Record<string, unknown>;

  if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) {
    return { error: `verdict must be one of ${VERDICTS.join(", ")}` };
  }
  if (typeof explanation !== "string" || !explanation.trim()) return { error: "explanation must be a non-empty string" };
  if (!Array.isArray(evidence)) return { error: "evidence must be an array" };

  const items: ParsedReply["evidence"] = [];
  for (const [i, e] of evidence.entries()) {
    const item = e as Record<string, unknown>;
    if (!Number.isInteger(item?.chunk) || (item.chunk as number) < 1 || (item.chunk as number) > chunkCount) {
      return { error: `evidence[${i}].chunk must be an integer from 1 to ${chunkCount}` };
    }
    if (typeof item.quote !== "string" || !item.quote.trim()) return { error: `evidence[${i}].quote must be a non-empty string` };
    if (item.stance !== "supports" && item.stance !== "contradicts") {
      return { error: `evidence[${i}].stance must be "supports" or "contradicts"` };
    }
    items.push({ chunk: item.chunk as number, quote: item.quote, stance: item.stance });
  }
  if (verdict !== "irrelevant" && !items.some((e) => e.stance === "supports")) {
    return { error: `a "${verdict}" verdict needs at least one supporting quote` };
  }
  return { value: { verdict: verdict as Verdict, explanation: explanation.trim(), evidence: items } };
}

/**
 * Find the quote inside its chunk and translate it to offsets in extracted_text.
 * Matching ignores case, whitespace runs, and curly-vs-straight quotes/dashes.
 */
export function locateQuote(e: ParsedReply["evidence"][number], chunk: RetrievedChunk): EvidenceItem {
  const { norm, map } = normalizeWithMap(chunk.text);
  const needle = normalizeWithMap(e.quote.trim().replace(/^["'“‘…]+|["'”’…]+$/g, "").replace(/^\.{3}|\.{3}$/g, "")).norm.trim();
  const at = needle ? norm.indexOf(needle) : -1;
  return {
    ...e,
    chunkId: chunk.chunkId,
    quoteStart: at >= 0 ? chunk.charStart + map[at] : null,
    quoteEnd: at >= 0 ? chunk.charStart + map[at + needle.length - 1] + 1 : null,
  };
}

function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (/\s/.test(ch)) {
      if (norm.endsWith(" ")) continue;
      ch = " ";
    }
    ch = ch.replace(/[‘’]/, "'").replace(/[“”]/, '"').replace(/[–—]/, "-").toLowerCase();
    norm += ch;
    map.push(i);
  }
  return { norm, map };
}
