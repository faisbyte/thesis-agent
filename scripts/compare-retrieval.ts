// Run both retrievers on one sentence and print their top results side by side. No model call.
//   npm run compare-retrieval -- --paper="<url or id>" --sentence="..." [--limit=5]
import { parseArgs } from "node:util";
import { openDb, PaperNotFoundError } from "../src/lib/db";
import { retrieveKeyword, type RetrievedChunk } from "../src/lib/retrieve-keyword";
import { localEmbedder, retrieveEmbed } from "../src/lib/retrieve-embed";

const { values } = parseArgs({
  options: { paper: { type: "string" }, sentence: { type: "string" }, limit: { type: "string", default: "5" } },
});
if (!values.paper || !values.sentence) {
  console.error('usage: npm run compare-retrieval -- --paper="<url or id>" --sentence="..." [--limit=5]');
  process.exit(2);
}
const limit = Number(values.limit);

const db = openDb();
let keyword: RetrievedChunk[];
let embed: RetrievedChunk[];
try {
  keyword = retrieveKeyword(db, values.paper, values.sentence, limit);
  embed = await retrieveEmbed(db, values.paper, values.sentence, localEmbedder(), limit);
} catch (err) {
  if (err instanceof PaperNotFoundError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
} finally {
  db.close();
}

const inBoth = new Set(keyword.map((c) => c.chunkId).filter((id) => embed.some((e) => e.chunkId === id)));
const COL = 60;
const SNIPPET_LINES = 3;

function cell(c: RetrievedChunk | undefined, scoreDigits: number): string[] {
  if (!c) return ["(none)"];
  const mark = inBoth.has(c.chunkId) ? "*" : " ";
  const head = `${mark}${c.score.toFixed(scoreDigits)}  #${c.ordinal} [${c.charStart}-${c.charEnd}] ${c.heading ?? ""}`;
  return [truncate(head, COL), ...wrap(c.text.replace(/\s+/g, " "), COL, SNIPPET_LINES)];
}

function wrap(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if ((line + " " + word).trim().length > width) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) lines[maxLines - 1] = truncate(lines[maxLines - 1] + " …", width);
  return lines;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

console.log(`sentence: ${values.sentence}\n`);
console.log(`     ${"KEYWORD (BM25)".padEnd(COL)}   EMBEDDING (cosine)`);
console.log(`     ${"-".repeat(COL)}   ${"-".repeat(COL)}`);
for (let i = 0; i < Math.max(keyword.length, embed.length, 1); i++) {
  const left = cell(keyword[i], 2);
  const right = cell(embed[i], 3);
  for (let j = 0; j < Math.max(left.length, right.length); j++) {
    const rank = j === 0 ? `#${i + 1}`.padEnd(5) : "     ";
    console.log(`${rank}${(left[j] ?? "").padEnd(COL)}   ${right[j] ?? ""}`);
  }
  console.log();
}
console.log(`* = chunk in both lists (${inBoth.size} of ${limit}). #N = chunk ordinal, [a-b] = char range in extracted_text.`);
