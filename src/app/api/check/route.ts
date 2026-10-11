import { checkCitation, type CheckRetriever } from "@/lib/check";
import { openDb } from "@/lib/db";
import { localEmbedder } from "@/lib/retrieve-embed";

export const runtime = "nodejs";

const RETRIEVERS: CheckRetriever[] = ["both", "embed", "keyword", "side-by-side"];

/** POST { url, sentence, retriever? } -> CheckItemResult. Ingests the paper first if it isn't stored. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { url?: unknown; sentence?: unknown; retriever?: unknown } | null;
  if (typeof body?.url !== "string" || typeof body.sentence !== "string") {
    return Response.json({ error: "body must be { url: string, sentence: string, retriever?: string }" }, { status: 400 });
  }
  if (body.retriever !== undefined && !RETRIEVERS.includes(body.retriever as CheckRetriever)) {
    return Response.json({ error: `retriever must be one of ${RETRIEVERS.join(", ")}` }, { status: 400 });
  }
  const db = openDb();
  try {
    const result = await checkCitation(
      { url: body.url, sentence: body.sentence, retriever: body.retriever as CheckRetriever | undefined },
      { db, embedder: localEmbedder() },
    );
    return Response.json(result);
  } finally {
    db.close();
  }
}
