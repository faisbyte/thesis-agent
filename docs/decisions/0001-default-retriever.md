# 0001: Merged retrieval is the default

Date: 2026-10-11 · Status: accepted (replaces the earlier "embedding is the default" version of this note)

## Decision

A normal check runs **both** retrievers. That means `check-citation` with no
`--retriever` flag, `/api/check` and `/api/check-batch` without a `retriever`,
and the UI's default option. Both are:

- FTS5/BM25 keyword retrieval (`retrieve-keyword.ts`), and
- local embedding retrieval with `bge-small-en-v1.5` (`retrieve-embed.ts`).

Each returns its top 5 chunks (`config.retrieveLimit`). The two lists are
merged into one evidence set, deduplicated by chunk id and capped at 10 chunks
(`config.mergedMaxChunks`). That set goes to **one** model call. Every chunk is
tagged with the retriever(s) that found it, and the CLI and UI show this as
"found via" next to each cited quote.

Single-retriever modes stay available and supported: `--retriever=embed`,
`--retriever=keyword`, and the matching UI options. The UI also keeps a
"side-by-side" mode that gets a separate verdict from each retriever (two
model calls). `compare-retrieval` still shows the two retrievers' raw lists
side by side.

## Why: neither retriever alone is safe

Each retriever produced a wrong verdict on a real Mixtral (arXiv 2401.04088)
sentence that the other got right.

**S1: embedding's blind spot, on the easiest case.**
"Mixtral has the same architecture as Mistral 7B, except that each layer is
composed of 8 feedforward blocks." This nearly copies the abstract.

- With embedding alone, the abstract wasn't in the top 5; the first chunk was
  about the licence and vLLM deployment. The model saw only "uses the same
  modifications as described in [18]", couldn't tell [18] was Mistral 7B, and
  answered **PARTIALLY RELEVANT**.
- With keyword, the abstract ranked first and the answer was **RELEVANT**.

Embeddings rank by topic, and inside one paper every chunk shares the topic.
So they can miss a passage that matches the sentence almost word for word.

**S9: keyword's blind spot, on a real paraphrase.**
"When the authors looked at which sub-networks handled text from different
academic fields, they found no clear division of labour." The sentence shares
almost no words with the passage it describes.

- With keyword alone, the routing-analysis section wasn't in the top 5, and
  the model answered **IRRELEVANT** for a true sentence.
- With embedding, the section ranked first and the answer was **RELEVANT**.

Each failure is a false negative: a correct citation marked as unsupported.
For a tool that replaces opening the paper by hand, that's the worst kind of
error, because it either wastes time or teaches you to ignore the verdict.

**Merged, both come out right.** Re-run with the merged default:

| | Evidence set | From embed only | From keyword only | Found by both | Verdict | Deciding chunk found via |
|---|---|---|---|---|---|---|
| S1 | 8 chunks | 3 | 3 | 2 | RELEVANT | keyword only (abstract, keyword rank 1) |
| S9 | 10 chunks | 5 | 5 | 0 | RELEVANT | embed only (Routing analysis, embed rank 2) |

In each case the chunk that decided the verdict came from the retriever that
the other one would have missed. That's the reason for merging.

## Cost

The evidence set grows from 5 chunks to between 5 and 10, depending on
overlap: 8 for S1, 10 for S9. It's still **one model call per check**, so
model cost goes up with input tokens and doesn't double. Input tokens grow
less than the chunk count, because the system prompt and the response are
fixed overheads. Measured on the real calls:

| | Input tokens | Output tokens | Cost |
|---|---|---|---|
| S1 embed only -> merged | 2,591 -> 3,410 (+32%) | 607 -> 221 | $0.0225 -> $0.0181 |
| S9 embed only -> merged | 2,715 -> 4,156 (+53%) | 364 -> 362 | $0.0182 -> $0.0239 |

Expect roughly a third to a half more input tokens per check. Output length
varies from call to call more than that, so a given check can even come out
cheaper. Typical cost is about two cents per check with Claude Opus 5.5. The
10-chunk cap is the ceiling: even when the two lists don't overlap at all, the
evidence set can't exceed 10 chunks.

Retrieval cost is negligible: both retrievers run locally, and chunk vectors
are computed once at ingest.

## Known limits

- **More evidence also means more distractors.** A 10-chunk set gives the
  model more off-topic text to weigh. S1 and S9 weren't affected, but the
  partially-relevant / irrelevant boundary should be watched.
- **The merge isn't a ranking.** Chunks are interleaved (embed #1, keyword #1,
  embed #2, ...), and the model sees them unordered by relevance. A reranker
  could do better. We haven't built one.
- **Embedding similarity still can't flag an off-topic sentence.** The
  LibriSpeech sentence scored the highest similarity of all nine test
  sentences. "Not covered" is decided by the model, which has handled it
  correctly so far.
- **The sample is small:** one paper, with sentences and gold labels written
  by us. The evidence above is two concrete failures, not a measured error
  rate.

## Revisit when

- A merged verdict looks wrong: check the "found via" tags and run
  `compare-retrieval` on the sentence to see what each retriever surfaced.
- Cost matters more than recall, e.g. very large batches: `--retriever=embed`
  or `keyword` halves the evidence, with the blind spots described above.
- Results on more papers, especially PDFs, show the 10-chunk cap is too tight
  or the extra chunks are confusing the model.
