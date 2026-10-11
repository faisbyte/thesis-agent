import { checkBatch, type CheckRetriever } from "@/lib/check";
import { openDb } from "@/lib/db";
import { localEmbedder } from "@/lib/retrieve-embed";

export const runtime = "nodejs";

/**
 * POST { items: [{ url, sentence }], retriever? } -> { results: CheckItemResult[] }
 * Runs sequentially; results are in input order and a failed item has `error` set.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { items?: unknown; retriever?: unknown } | null;
  const items = body?.items;
  if (!Array.isArray(items) || items.some((i) => typeof i?.url !== "string" || typeof i?.sentence !== "string")) {
    return Response.json({ error: "body must be { items: [{ url: string, sentence: string }] }" }, { status: 400 });
  }
  const retriever = body?.retriever as CheckRetriever | undefined;
  if (retriever !== undefined && !["both", "embed", "keyword", "side-by-side"].includes(retriever)) {
    return Response.json({ error: "retriever must be one of both, embed, keyword, side-by-side" }, { status: 400 });
  }
  const db = openDb();
  try {
    const results = await checkBatch(
      items.map((i: { url: string; sentence: string }) => ({ url: i.url, sentence: i.sentence, retriever })),
      { db, embedder: localEmbedder() },
    );
    return Response.json({ results });
  } finally {
    db.close();
  }
}
