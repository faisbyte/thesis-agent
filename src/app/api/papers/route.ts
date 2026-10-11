import { listPapers, openDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = openDb();
  try {
    return Response.json({ papers: listPapers(db) });
  } finally {
    db.close();
  }
}
