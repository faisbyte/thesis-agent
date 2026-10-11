# 0001: Embedding retrieval is the default; keyword stays as a cross-check

Date: 2026-10-11 · Status: accepted

## Decision

`check-citation` retrieves evidence with the embedding retriever by default
(`config.defaultRetriever = "embed"`, local `bge-small-en-v1.5`). The FTS5/BM25
keyword retriever stays in the codebase. It is reachable with
`--retriever=keyword` and always shown next to the embedding results by
`npm run compare-retrieval`. Use it as a fallback and a cross-check. It is not
deprecated.

## Why embedding is the default

Citation sentences are usually paraphrases of the paper, not quotes. On 9
hand-written sentences checked against the Mixtral paper (arXiv 2401.04088),
each retriever was scored by the rank of the first chunk that actually supports
the sentence, out of all 41 chunks:

| Sentence type | Keyword rank | Embedding rank |
|---|---|---|
| S1 echo of the paper's wording | **1** | 2 |
| S2–S5 paraphrases | 1, 4, 1, 1 | 1, 1, 1, 1 |
| S8, S9 low-overlap paraphrases | 2, **6** | 1, 1 |
| S7 plausible but false | **1** | 3 |

Across the 8 sentences with a supporting chunk, the embedding retriever had a
supporting chunk in its top 5 every time (8/8) and first 6/8 times. Keyword
managed 7/8 and 5/8.

The miss that matters is S9. Keyword's top 5 had no supporting chunk, and the
end-to-end verdict on a true sentence was **IRRELEVANT**. With embedding, the
same sentence got **RELEVANT**, with the supporting quote located verbatim in
"5 Routing analysis". A wrong "irrelevant" verdict caused by a retrieval miss
is the failure most likely to make this tool lie.

## Why keyword stays

Keyword ranked the supporting chunk first in two cases where embedding didn't:

- **S1 (echo).** Embedding put a generic licence/deployment chunk first. It had
  the supporting chunk second.
- **S7 (false claim about routing).** Embedding had the contradicting chunk
  third.

In both cases embedding still had the chunk in its top 5, so the verdict should
survive. The pattern is still real: embeddings rank by topic, and inside one
paper every chunk shares the topic. Keyword wins when the sentence uses the
paper's own terms.

## Known limits of both

- **Embedding similarity can't tell an off-topic sentence from a supported
  one.** The off-topic LibriSpeech sentence got the highest top similarity of
  all nine (0.793). So we set no similarity threshold, and "not covered" is
  decided by the model. In the one real run, it correctly answered irrelevant.
- **Keyword retrieval almost never returns zero chunks** for a sentence that
  names the model, so the skip-the-model-call path rarely fires.
- **The sample is small:** one paper, with sentences and gold labels written by
  us. It shows a direction. It isn't a measurement.

## Revisit when

- A verdict looks wrong: run `compare-retrieval` on that sentence. If keyword
  finds the supporting chunk and embedding doesn't, record the case.
- Several such cases pile up: consider combining the two retrievers (a hybrid)
  or adding a reranker.
- We test more papers, especially PDFs, where weaker heading detection affects
  both retrievers.
