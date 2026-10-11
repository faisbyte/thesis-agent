import { openDb } from "@/lib/db";
import { ingestPaper } from "@/lib/ingest";
import { localEmbedder } from "@/lib/retrieve-embed";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
  if (typeof body?.url !== "string" || !body.url.trim()) {
    return Response.json({ error: "body must be { url: string }" }, { status: 400 });
  }
  const db = openDb();
  try {
    const result = await ingestPaper(body.url.trim(), { db, embedder: localEmbedder() });
    return Response.json(result, { status: result.outcome === "FAILED" ? 502 : 200 });
  } finally {
    db.close();
  }
}
