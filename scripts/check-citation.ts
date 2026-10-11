// Check whether a sentence is supported by an already-ingested paper.
//   npm run check-citation -- --paper="<url or id>" --sentence="..." [--retriever=keyword|embed] [--limit=5]
import { parseArgs } from "node:util";
import { config } from "../src/lib/config";
import { openDb, PaperNotFoundError } from "../src/lib/db";
import { ModelError } from "../src/lib/model";
import { localEmbedder } from "../src/lib/retrieve-embed";
import { verifyCitation, VerificationError, type RetrieverName } from "../src/lib/verify";

const { values } = parseArgs({
  options: {
    paper: { type: "string" },
    sentence: { type: "string" },
    retriever: { type: "string", default: config.defaultRetriever },
    limit: { type: "string", default: String(config.retrieveLimit) },
  },
});
if (!values.paper || !values.sentence || !["both", "keyword", "embed"].includes(values.retriever!)) {
  console.error('usage: npm run check-citation -- --paper="<url or id>" --sentence="..." [--retriever=both|embed|keyword] [--limit=5]');
  process.exit(2);
}
const retriever = values.retriever as RetrieverName;

const db = openDb();
try {
  const r = await verifyCitation({
    db,
    paper: values.paper,
    sentence: values.sentence,
    retriever,
    embedder: retriever === "keyword" ? undefined : localEmbedder(),
    limit: Number(values.limit),
  });

  console.log(`VERDICT      ${r.verdict.toUpperCase()}${r.grounded ? "" : "   (UNVERIFIED: a quote was not found in its chunk, check by hand)"}`);
  console.log(`paper        ${r.paperId}`);
  console.log(`sentence     ${r.sentence}`);
  const label = { both: `merged embed (${config.embedModel}) + keyword (FTS5/BM25)`, embed: `embed (${config.embedModel})`, keyword: "keyword (FTS5/BM25)" }[r.retriever];
  const count = (s: string) => r.chunks.filter((c) => c.foundBy.includes(s as "embed")).length;
  const overlap = r.chunks.filter((c) => c.foundBy.length === 2).length;
  console.log(`retriever    ${r.retriever}: ${label}`);
  console.log(`evidence     ${r.chunks.length} chunks` + (r.retriever === "both" ? ` (embed ${count("embed")}, keyword ${count("keyword")}, found by both ${overlap})` : ""));
  console.log(`model        ${r.model ?? "(not called)"}, ${r.modelCalls} call(s)`);
  console.log(`\n${r.explanation}\n`);

  for (const e of r.evidence) {
    const c = r.chunks[e.chunk - 1];
    const where =
      e.quoteStart !== null ? `quote at chars ${e.quoteStart}-${e.quoteEnd}` : "QUOTE NOT FOUND in chunk text";
    console.log(`[${e.stance}] evidence chunk ${e.chunk} = stored chunk #${c.ordinal} "${c.heading ?? ""}" chars ${c.charStart}-${c.charEnd}, ${where}`);
    console.log(`    found via: ${foundVia(c)}`);
    console.log(`    "${e.quote}"`);
  }
  if (r.evidence.length === 0) console.log("(no evidence cited)");
} catch (err) {
  if (err instanceof PaperNotFoundError || err instanceof ModelError || err instanceof VerificationError) {
    console.error(`FAILED  ${err.message}`);
    if (err instanceof VerificationError) for (const raw of err.rawReplies) console.error(`--- raw reply ---\n${raw}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  db.close();
}

function foundVia(c: { foundBy: string[]; ranks: { embed?: number; keyword?: number } }): string {
  return c.foundBy.map((s) => `${s} (rank ${c.ranks[s as "embed" | "keyword"]})`).join(", ");
}
