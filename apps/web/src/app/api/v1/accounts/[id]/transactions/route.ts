import { NextRequest, NextResponse } from "next/server";
import { mongoDb } from "@/lib/mongo";

// GET /api/v1/accounts/{id}/transactions?cursor=&limit=20 — paginación por cursor (created_at+_id).
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? 20), 100);
  const cursor = new URL(req.url).searchParams.get("cursor");
  const db = await mongoDb();
  const q: any = { account_id: params.id };
  if (cursor) {
    try {
      const c = JSON.parse(Buffer.from(cursor, "base64").toString());
      q.created_at = { $lt: c.created_at };
    } catch {}
  }
  const docs = await db.collection("movements").find(q).sort({ created_at: -1 }).limit(limit + 1).toArray();
  const has_more = docs.length > limit;
  const data = docs.slice(0, limit);
  const next_cursor = has_more ? Buffer.from(JSON.stringify({ created_at: data[data.length - 1].created_at })).toString("base64") : null;
  return NextResponse.json({ data, next_cursor, has_more });
}
